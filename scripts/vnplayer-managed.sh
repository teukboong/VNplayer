#!/usr/bin/env bash
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

set -a
if [[ -f ".env" ]]; then
  # shellcheck disable=SC1091
  source ".env"
fi
set +a

ACTION="${1:-start}"
shift || true

DETACH=1
WAIT_HEALTH=1
RUN_ID="${VNPLAYER_RUN_ID:-managed-$(date -u +%Y%m%dT%H%M%SZ)}"
WEB_PORT="${VNPLAYER_WEB_PORT:-4173}"
WEB_HOST="${VNPLAYER_WEB_HOST:-127.0.0.1}"
API_PORT="${VNPLAYER_PORT:-4174}"
LOCAL_BASE_URL="${VNPLAYER_LOCAL_BASE_URL:-http://127.0.0.1:${API_PORT}}"
CG_WORKER="${VNPLAYER_DEV_CG_WORKER:-1}"
MCP_TUNNEL="${VNPLAYER_DEV_MCP_TUNNEL:-1}"
CONNECTOR_APP_NAME="${VNPLAYER_WEBGPT_CONNECTOR_APP_NAME:-VNplayer Live SchemaFlat}"
STATE_DIR=".runtime/${RUN_ID}"
LOG_FILE="data/dev-${RUN_ID}.log"
SCREEN_NAME="vnplayer-dev-${RUN_ID}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/vnplayer-managed.sh start [--foreground] [--no-cg] [--no-tunnel] [--run-id ID]
  bash scripts/vnplayer-managed.sh restart [same options as start]
  bash scripts/vnplayer-managed.sh stop
  bash scripts/vnplayer-managed.sh status

The start/restart path first cleans up orphaned VNplayer dev processes, stale
tunnel locks, and CG jobs left in running state by a killed worker.
EOF
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --foreground|--fg)
      DETACH=0
      ;;
    --no-wait)
      WAIT_HEALTH=0
      ;;
    --no-cg)
      CG_WORKER=0
      ;;
    --no-tunnel)
      MCP_TUNNEL=0
      ;;
    --run-id)
      shift
      RUN_ID="${1:?--run-id requires a value}"
      STATE_DIR=".runtime/${RUN_ID}"
      LOG_FILE="data/dev-${RUN_ID}.log"
      SCREEN_NAME="vnplayer-dev-${RUN_ID}"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift || true
done

log() {
  printf '[vnplayer-managed] %s\n' "$*"
}

is_live_pid() {
  [[ -n "${1:-}" ]] && kill -0 "$1" >/dev/null 2>&1
}

append_pid() {
  local pid="$1"
  [[ -z "${pid}" || "${pid}" == "$$" || "${pid}" == "$PPID" ]] && return 0
  printf '%s\n' "$pid"
}

port_pids() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true
  fi
}

pattern_pids() {
  local pattern="$1"
  pgrep -f "$pattern" 2>/dev/null || true
}

known_vnplayer_pids() {
  {
    port_pids "${WEB_PORT}"
    port_pids "${API_PORT}"
    pattern_pids "node scripts/dev\\.mjs"
    pattern_pids "node dist/server/apps/server/src/index\\.js"
    pattern_pids "node .*scripts/webgpt-cg-worker\\.mjs"
    pattern_pids "node .*scripts/webgpt-cg-once\\.mjs"
    pattern_pids "bash scripts/run-mcp-tunnel\\.sh"
    pattern_pids "cloudflared tunnel .*--url http://127\\.0\\.0\\.1:${API_PORT}"
  } | while IFS= read -r pid; do append_pid "$pid"; done | sort -un
}

screen_sessions() {
  if ! command -v screen >/dev/null 2>&1; then
    return 0
  fi
  screen -ls 2>/dev/null | awk '/vnplayer-dev-/ { print $1 }' || true
}

stop_screen_sessions() {
  local sessions session count=0
  sessions="$(screen_sessions)"
  [[ -z "${sessions}" ]] && return 0
  while IFS= read -r session; do
    [[ -z "${session}" ]] && continue
    log "stopping screen session ${session}"
    screen -S "${session}" -X quit >/dev/null 2>&1 || true
    count=$((count + 1))
  done <<< "${sessions}"
  [[ "${count}" -gt 0 ]] && sleep 1
}

terminate_pids() {
  local pids="$1"
  [[ -z "${pids}" ]] && return 0

  log "terminating stale VNplayer pids: $(tr '\n' ' ' <<< "${pids}")"
  while IFS= read -r pid; do
    is_live_pid "${pid}" && kill -TERM "${pid}" >/dev/null 2>&1 || true
  done <<< "${pids}"

  for _ in 1 2 3 4 5; do
    local any_live=0
    while IFS= read -r pid; do
      if is_live_pid "${pid}"; then
        any_live=1
        break
      fi
    done <<< "${pids}"
    [[ "${any_live}" -eq 0 ]] && return 0
    sleep 0.5
  done

  while IFS= read -r pid; do
    is_live_pid "${pid}" && kill -KILL "${pid}" >/dev/null 2>&1 || true
  done <<< "${pids}"
}

clean_stale_tunnel_locks() {
  [[ -d ".runtime" ]] || return 0
  while IFS= read -r lock_dir; do
    local pid_file pid
    pid_file="${lock_dir}/pid"
    pid="$(cat "${pid_file}" 2>/dev/null || true)"
    if ! is_live_pid "${pid}"; then
      log "removing stale tunnel lock ${lock_dir}"
      rm -rf "${lock_dir}"
    fi
  done < <(find .runtime -type d -name 'mcp_tunnel.lock' 2>/dev/null || true)
}

requeue_orphaned_cg_jobs() {
  [[ "${VNPLAYER_MANAGED_REQUEUE_CG:-1}" == "1" ]] || return 0
  [[ -f "data/vnplayer.sqlite" ]] || return 0

  node --experimental-sqlite --input-type=module <<'NODE'
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data/vnplayer.sqlite");
const running = db
  .prepare(
    `UPDATE webgpt_jobs
        SET status = 'queued',
            started_at = NULL,
            finished_at = NULL,
            error_message = NULL
      WHERE lane = 'cg_side'
        AND status = 'running'`
  )
  .run();
const waitingJobs = db
  .prepare(
    `UPDATE webgpt_jobs
        SET status = 'queued',
            started_at = NULL,
            finished_at = NULL,
            error_message = NULL
      WHERE lane = 'cg_side'
        AND kind = 'cg_asset'
        AND status = 'waiting_reference'`
  )
  .run();
const waitingAssets = db
  .prepare(
    `UPDATE cg_assets
        SET status = 'requested',
            error_message = NULL,
            updated_at = datetime('now')
      WHERE status = 'waiting_reference'`
  )
  .run();
console.log(`[vnplayer-managed] recovered CG jobs: running=${running.changes}, waiting_jobs=${waitingJobs.changes}, waiting_assets=${waitingAssets.changes}`);
db.close();
NODE
}

cleanup() {
  stop_screen_sessions
  terminate_pids "$(known_vnplayer_pids)"
  clean_stale_tunnel_locks
  requeue_orphaned_cg_jobs
}

health_status() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "${LOCAL_BASE_URL}/api/health" 2>/dev/null || true)"
  [[ -n "${code}" ]] && printf '%s' "${code}" || printf 'unreachable'
}

status() {
  log "backend health ${LOCAL_BASE_URL}/api/health -> $(health_status)"
  local pids sessions
  pids="$(known_vnplayer_pids)"
  sessions="$(screen_sessions)"
  if [[ -n "${sessions}" ]]; then
    log "screen sessions:"
    printf '%s\n' "${sessions}"
  fi
  if [[ -n "${pids}" ]]; then
    log "processes:"
    local pid_csv
    pid_csv="$(printf '%s\n' "${pids}" | paste -sd, -)"
    ps -o pid,ppid,etime,command -p "${pid_csv}" 2>/dev/null || true
  else
    log "no known VNplayer dev processes"
  fi
}

wait_for_health() {
  [[ "${WAIT_HEALTH}" == "1" ]] || return 0
  for _ in $(seq 1 80); do
    if [[ "$(health_status)" =~ ^2[0-9][0-9]$ ]]; then
      log "backend ready: ${LOCAL_BASE_URL}/api/health"
      return 0
    fi
    sleep 0.5
  done
  log "WARN: backend did not become healthy within 40s"
}

start_foreground() {
  mkdir -p "${STATE_DIR}" data
  log "starting foreground dev stack run_id=${RUN_ID}"
  env \
    RUN_ID="${RUN_ID}" \
    VNPLAYER_WEB_HOST="${WEB_HOST}" \
    VNPLAYER_WEB_PORT="${WEB_PORT}" \
    VNPLAYER_DEV_CG_WORKER="${CG_WORKER}" \
    VNPLAYER_DEV_MCP_TUNNEL="${MCP_TUNNEL}" \
    VNPLAYER_WEBGPT_CG_ALLOW_GLOBAL="${VNPLAYER_WEBGPT_CG_ALLOW_GLOBAL:-1}" \
    VNPLAYER_WEBGPT_CG_ACTIVE_ONLY="${VNPLAYER_WEBGPT_CG_ACTIVE_ONLY:-1}" \
    VNPLAYER_WEBGPT_CONNECTOR_APP_NAME="${CONNECTOR_APP_NAME}" \
    VNPLAYER_TUNNEL_STATE_FILE="${STATE_DIR}/mcp_tunnel_base_url.txt" \
    VNPLAYER_TUNNEL_PENDING_FILE="${STATE_DIR}/mcp_tunnel_origin_pending.txt" \
    VNPLAYER_TUNNEL_LOCK_DIR="${STATE_DIR}/mcp_tunnel.lock" \
    VNPLAYER_TUNNEL_LOG_PIPE_DIR="${STATE_DIR}/mcp_tunnel_pipes" \
    npm run dev
}

quote() {
  printf '%q' "$1"
}

start_detached() {
  if ! command -v screen >/dev/null 2>&1; then
    log "screen not found; falling back to foreground"
    start_foreground
    return
  fi

  mkdir -p "${STATE_DIR}" data
  local command
  command="cd $(quote "$PWD") && RUN_ID=$(quote "$RUN_ID") VNPLAYER_WEB_HOST=$(quote "$WEB_HOST") VNPLAYER_WEB_PORT=$(quote "$WEB_PORT") VNPLAYER_DEV_CG_WORKER=$(quote "$CG_WORKER") VNPLAYER_DEV_MCP_TUNNEL=$(quote "$MCP_TUNNEL") VNPLAYER_WEBGPT_CG_ALLOW_GLOBAL=$(quote "${VNPLAYER_WEBGPT_CG_ALLOW_GLOBAL:-1}") VNPLAYER_WEBGPT_CG_ACTIVE_ONLY=$(quote "${VNPLAYER_WEBGPT_CG_ACTIVE_ONLY:-1}") VNPLAYER_WEBGPT_CONNECTOR_APP_NAME=$(quote "$CONNECTOR_APP_NAME") VNPLAYER_TUNNEL_STATE_FILE=$(quote "${STATE_DIR}/mcp_tunnel_base_url.txt") VNPLAYER_TUNNEL_PENDING_FILE=$(quote "${STATE_DIR}/mcp_tunnel_origin_pending.txt") VNPLAYER_TUNNEL_LOCK_DIR=$(quote "${STATE_DIR}/mcp_tunnel.lock") VNPLAYER_TUNNEL_LOG_PIPE_DIR=$(quote "${STATE_DIR}/mcp_tunnel_pipes") npm run dev 2>&1 | tee $(quote "$LOG_FILE")"

  log "starting detached screen ${SCREEN_NAME}"
  screen -dmS "${SCREEN_NAME}" zsh -lc "${command}"
  wait_for_health
  log "log: ${LOG_FILE}"
  if [[ "${MCP_TUNNEL}" != "0" ]]; then
    if [[ -n "${VNPLAYER_FRONTDOOR_URL:-}" ]]; then
      log "frontdoor MCP: ${VNPLAYER_FRONTDOOR_URL%/}/mcp"
    else
      log "frontdoor MCP: set VNPLAYER_FRONTDOOR_URL to expose /mcp"
    fi
  fi
}

case "${ACTION}" in
  start)
    cleanup
    if [[ "${DETACH}" == "1" ]]; then
      start_detached
    else
      start_foreground
    fi
    ;;
  restart)
    cleanup
    if [[ "${DETACH}" == "1" ]]; then
      start_detached
    else
      start_foreground
    fi
    ;;
  stop)
    cleanup
    ;;
  status)
    status
    ;;
  *)
    echo "Unknown action: ${ACTION}" >&2
    usage >&2
    exit 2
    ;;
esac
