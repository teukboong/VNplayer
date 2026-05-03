#!/usr/bin/env bash
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

MODE_OVERRIDE="${VNPLAYER_TUNNEL:-}"

set -a
if [[ -f ".env" ]]; then
  # shellcheck disable=SC1091
  source ".env"
fi
set +a

if [[ -n "${MODE_OVERRIDE}" ]]; then
  export VNPLAYER_TUNNEL="${MODE_OVERRIDE}"
fi

MODE="${VNPLAYER_TUNNEL:-cloudflared}"
TARGET_URL="${VNPLAYER_TUNNEL_TARGET_URL:-http://127.0.0.1:4174}"
STATE_FILE="${VNPLAYER_TUNNEL_STATE_FILE:-.runtime/mcp_tunnel_base_url.txt}"
PENDING_FILE="${VNPLAYER_TUNNEL_PENDING_FILE:-.runtime/mcp_tunnel_origin_pending.txt}"
LOCK_DIR="${VNPLAYER_TUNNEL_LOCK_DIR:-.runtime/mcp_tunnel.lock}"
LOG_PIPE_DIR="${VNPLAYER_TUNNEL_LOG_PIPE_DIR:-.runtime/mcp_tunnel_pipes}"
RETRY_BACKOFF_SEC="${VNPLAYER_TUNNEL_RETRY_BACKOFF_SEC:-5}"
RETRY_BACKOFF_MAX_SEC="${VNPLAYER_TUNNEL_RETRY_BACKOFF_MAX_SEC:-120}"
ORIGIN_RETRY_INTERVAL_SEC="${VNPLAYER_TUNNEL_ORIGIN_RETRY_INTERVAL_SEC:-30}"
STABLE_RUN_RESET_SEC="${VNPLAYER_TUNNEL_STABLE_RUN_RESET_SEC:-180}"
HEALTH_CHECK="${VNPLAYER_TUNNEL_HEALTH_CHECK:-1}"
HEALTH_PATH="${VNPLAYER_TUNNEL_HEALTH_PATH:-/api/health}"
HEALTH_INTERVAL_SEC="${VNPLAYER_TUNNEL_HEALTH_INTERVAL_SEC:-15}"
HEALTH_TIMEOUT_SEC="${VNPLAYER_TUNNEL_HEALTH_TIMEOUT_SEC:-10}"
HEALTH_INITIAL_GRACE_SEC="${VNPLAYER_TUNNEL_HEALTH_INITIAL_GRACE_SEC:-30}"
HEALTH_FAILURE_LIMIT="${VNPLAYER_TUNNEL_HEALTH_FAILURE_LIMIT:-3}"
BACKOFF_SEC="${RETRY_BACKOFF_SEC}"

mkdir -p "$(dirname "${STATE_FILE}")" "$(dirname "${PENDING_FILE}")" "${LOG_PIPE_DIR}"
touch "${STATE_FILE}" "${PENDING_FILE}"

_now_epoch() {
  date +%s
}

_trimmed_file_value() {
  local path="$1"
  if [[ ! -f "${path}" ]]; then
    return 0
  fi
  tr -d '\r\n' < "${path}" 2>/dev/null || true
}

_state_url() {
  _trimmed_file_value "${STATE_FILE}"
}

_pending_url() {
  _trimmed_file_value "${PENDING_FILE}"
}

_set_pending_url() {
  printf '%s' "$1" > "${PENDING_FILE}"
}

_clear_pending_url() {
  : > "${PENDING_FILE}"
}

_acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    printf '%s' "$$" > "${LOCK_DIR}/pid"
    TUNNEL_LOCK_HELD=1
    return 0
  fi

  local existing_pid
  existing_pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" >/dev/null 2>&1; then
    echo "MCP tunnel manager already running with pid ${existing_pid}; leaving it in charge."
    exit 0
  fi

  echo "Removing stale MCP tunnel lock."
  rm -f "${LOCK_DIR}/pid"
  rmdir "${LOCK_DIR}" 2>/dev/null || true
  if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
    echo "Another MCP tunnel manager acquired the lock first."
    exit 0
  fi
  printf '%s' "$$" > "${LOCK_DIR}/pid"
  TUNNEL_LOCK_HELD=1
}

_release_lock() {
  if [[ "${TUNNEL_LOCK_HELD:-0}" == "1" ]]; then
    rm -f "${LOCK_DIR}/pid"
    rmdir "${LOCK_DIR}" 2>/dev/null || true
  fi
}

_apply_public_url() {
  local url="$1"
  local frontdoor="${VNPLAYER_FRONTDOOR_URL:-}"
  local secret="${VNPLAYER_FRONTDOOR_UPDATE_SECRET:-}"
  frontdoor="${frontdoor%/}"

  if [[ "${secret}" =~ ^\$\{KEYCHAIN:([^/]+)/([^}]+)\}$ ]]; then
    local service account
    service="${BASH_REMATCH[1]}"
    account="${BASH_REMATCH[2]}"
    secret="$(security find-generic-password -s "${service}" -a "${account}" -w)"
  fi

  if [[ -z "${frontdoor}" || -z "${secret}" ]]; then
    echo "WARN: Missing VNPLAYER_FRONTDOOR_URL or VNPLAYER_FRONTDOOR_UPDATE_SECRET."
    echo "      Public tunnel URL is ${url}"
    return 1
  fi

  echo "Updating VNplayer front door origin via Worker: ${frontdoor}"
  if curl --config - >/dev/null <<CURL_CONFIG
fail
show-error
silent
request = "POST"
url = "${frontdoor}/_vnplayer/origin"
header = "Content-Type: application/json"
header = "X-VNplayer-Origin-Update-Secret: ${secret}"
data = "{\"origin\":\"${url}\"}"
CURL_CONFIG
  then
    echo "OK: Worker KV updated"
    return 0
  fi

  echo "WARN: Failed to update Worker KV. Check front door URL, secret, and Worker deployment."
  return 1
}

_commit_synced_url() {
  local url="$1"
  printf '%s' "${url}" > "${STATE_FILE}"
  _clear_pending_url
  echo "Origin sync committed: ${url}"
  if [[ -n "${VNPLAYER_FRONTDOOR_URL:-}" ]]; then
    echo "ChatGPT MCP URL: ${VNPLAYER_FRONTDOOR_URL%/}/mcp"
  fi
}

_sync_url_if_needed() {
  local url="$1"
  local last pending
  last="$(_state_url)"
  pending="$(_pending_url)"

  if [[ "${url}" == "${last}" && "${pending}" != "${url}" ]]; then
    return 0
  fi

  if [[ "${url}" != "${last}" ]]; then
    echo "Detected new public URL: ${url}"
  else
    echo "Origin sync still pending for current URL: ${url} (retry)"
  fi

  if _apply_public_url "${url}"; then
    _commit_synced_url "${url}"
    return 0
  fi

  _set_pending_url "${url}"
  return 1
}

_retry_pending_origin_if_any() {
  local pending now last_retry
  pending="$(_pending_url)"
  if [[ -z "${pending}" ]]; then
    return 0
  fi

  now="$(_now_epoch)"
  last_retry="${ORIGIN_LAST_RETRY_AT_EPOCH:-0}"
  if [[ "${last_retry}" -gt 0 && $((now - last_retry)) -lt "${ORIGIN_RETRY_INTERVAL_SEC}" ]]; then
    return 0
  fi

  export ORIGIN_LAST_RETRY_AT_EPOCH="${now}"
  echo "[origin-sync] retry pending URL: ${pending}"
  if _apply_public_url "${pending}"; then
    _commit_synced_url "${pending}"
  else
    echo "[origin-sync] retry failed; will retry in ${ORIGIN_RETRY_INTERVAL_SEC}s"
  fi
}

_start_pending_sync_loop() {
  while true; do
    _retry_pending_origin_if_any || true
    sleep "${ORIGIN_RETRY_INTERVAL_SEC}"
  done
}

_health_probe_url() {
  local frontdoor="${VNPLAYER_FRONTDOOR_URL:-}"
  frontdoor="${frontdoor%/}"
  if [[ -n "${frontdoor}" ]]; then
    printf '%s%s' "${frontdoor}" "${HEALTH_PATH}"
    return 0
  fi

  local origin
  origin="$(_state_url)"
  origin="${origin%/}"
  if [[ -n "${origin}" ]]; then
    printf '%s%s' "${origin}" "${HEALTH_PATH}"
  fi
}

_start_health_watchdog() {
  local tunnel_pid="$1"
  if [[ "${HEALTH_CHECK}" == "0" ]]; then
    return 0
  fi

  (
    sleep "${HEALTH_INITIAL_GRACE_SEC}"
    local failures=0
    while kill -0 "${tunnel_pid}" >/dev/null 2>&1; do
      local probe status
      probe="$(_health_probe_url)"
      if [[ -z "${probe}" ]]; then
        sleep "${HEALTH_INTERVAL_SEC}"
        continue
      fi

      status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "${HEALTH_TIMEOUT_SEC}" "${probe}" 2>/dev/null || true)"
      if [[ "${status}" =~ ^2[0-9][0-9]$ ]]; then
        failures=0
      else
        failures=$((failures + 1))
        echo "[frontdoor-health] ${probe} returned ${status:-curl_failed} (${failures}/${HEALTH_FAILURE_LIMIT})"
      fi

      if [[ "${failures}" -ge "${HEALTH_FAILURE_LIMIT}" ]]; then
        echo "[frontdoor-health] restarting cloudflared so a fresh origin can be registered"
        kill "${tunnel_pid}" >/dev/null 2>&1 || true
        break
      fi

      sleep "${HEALTH_INTERVAL_SEC}"
    done
  ) &
  HEALTH_WATCHDOG_PID=$!
}

_stop_health_watchdog() {
  if [[ -n "${HEALTH_WATCHDOG_PID:-}" ]]; then
    kill "${HEALTH_WATCHDOG_PID}" >/dev/null 2>&1 || true
    wait "${HEALTH_WATCHDOG_PID}" >/dev/null 2>&1 || true
    unset HEALTH_WATCHDOG_PID
  fi
}

_cleanup_background() {
  _stop_health_watchdog
  if [[ -n "${TUNNEL_PID:-}" ]]; then
    kill "${TUNNEL_PID}" >/dev/null 2>&1 || true
    wait "${TUNNEL_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${ORIGIN_SYNC_PID:-}" ]]; then
    kill "${ORIGIN_SYNC_PID}" >/dev/null 2>&1 || true
    wait "${ORIGIN_SYNC_PID}" >/dev/null 2>&1 || true
  fi
  _release_lock
}

_reset_backoff() {
  BACKOFF_SEC="${RETRY_BACKOFF_SEC}"
}

_increase_backoff() {
  if [[ "${BACKOFF_SEC}" -lt "${RETRY_BACKOFF_MAX_SEC}" ]]; then
    BACKOFF_SEC=$((BACKOFF_SEC * 2))
    if [[ "${BACKOFF_SEC}" -gt "${RETRY_BACKOFF_MAX_SEC}" ]]; then
      BACKOFF_SEC="${RETRY_BACKOFF_MAX_SEC}"
    fi
  fi
}

_handle_tunnel_exit() {
  local mode="$1"
  local exit_code="$2"
  local run_elapsed="$3"

  if [[ "${run_elapsed}" -ge "${STABLE_RUN_RESET_SEC}" ]]; then
    _reset_backoff
  fi

  if [[ "${exit_code}" -eq 0 ]]; then
    echo "[${mode}] tunnel exited cleanly; restarting in 1s"
    _reset_backoff
    sleep 1
    return
  fi

  echo "[${mode}] tunnel failed (exit=${exit_code}); retrying in ${BACKOFF_SEC}s"
  sleep "${BACKOFF_SEC}"
  _increase_backoff
}

_acquire_lock
_start_pending_sync_loop &
ORIGIN_SYNC_PID=$!
trap _cleanup_background EXIT INT TERM

if [[ "${MODE}" == "cloudflared" ]]; then
  BIN="${VNPLAYER_CLOUDFLARED_BIN:-cloudflared}"
  if ! command -v "${BIN}" >/dev/null 2>&1; then
    echo "cloudflared not found. Install it first: brew install cloudflared"
    exit 1
  fi

  echo "Starting cloudflared quick tunnel -> ${TARGET_URL}"
  echo "State file: ${STATE_FILE}"
  while true; do
    _retry_pending_origin_if_any || true
    run_started_at="$(_now_epoch)"
    pipe_path="${LOG_PIPE_DIR}/mcp_tunnel_$$_${RANDOM}.pipe"
    mkfifo "${pipe_path}"
    set +e
    "${BIN}" tunnel --no-autoupdate --url "${TARGET_URL}" > "${pipe_path}" 2>&1 &
    TUNNEL_PID=$!
    _start_health_watchdog "${TUNNEL_PID}"
    while IFS= read -r line; do
      printf '%s\n' "${line}"
      url="$(printf '%s' "${line}" | grep -oE 'https://[A-Za-z0-9.-]+\.trycloudflare\.com' | head -n 1 || true)"
      if [[ -n "${url}" ]]; then
        _sync_url_if_needed "${url}" || true
      fi
    done < "${pipe_path}"
    wait "${TUNNEL_PID}"
    exit_code="$?"
    _stop_health_watchdog
    unset TUNNEL_PID
    rm -f "${pipe_path}"
    run_elapsed="$(( $(_now_epoch) - run_started_at ))"
    set -e
    _handle_tunnel_exit "cloudflared" "${exit_code}" "${run_elapsed}"
  done
fi

echo "Unsupported VNPLAYER_TUNNEL=${MODE}"
echo "Supported: cloudflared"
exit 1
