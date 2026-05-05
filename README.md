# VNplayer

VNplayer is a local-first TypeScript player for live-authored literary worlds.
It renders, stores, restores, validates, and hands visible context to an
external authoring lane. It does not write the story itself.

```text
VNplayer frontend
  -> local backend + SQLite
  -> connector-visible forms
  -> WebGPT / LLM writes the next turn through MCP tools
  -> backend stores the committed turn
  -> frontend renders the committed turn
```

The waterline matters: backend machinery can support continuity, storage,
session restore, provenance, retrieval, and connector forms. It must not become
a prose writer, choice writer, story director, or narrative judge.

## Stack

- TypeScript
- React
- Vite
- Node local backend
- SQLite
- Zustand
- Zod
- Playwright
- Plain CSS

## Quick Start

```bash
npm install
cp .env.example .env
VNPLAYER_DEV_MCP_TUNNEL=0 npm run dev:no-cg
```

Open:

- frontend: `http://127.0.0.1:4173`
- backend health: `http://127.0.0.1:4174/api/health`
- local connector manifest: `http://127.0.0.1:4174/api/webgpt/manifest`

For the supervised local stack:

```bash
npm run dev:managed
npm run status
npm run stop
npm run restart
```

`npm run dev:managed` cleans up orphaned VNplayer dev processes, stale tunnel
locks, and CG jobs left in running state before starting the stack.

Use a local-only run when you do not need the public MCP front door:

```bash
VNPLAYER_DEV_MCP_TUNNEL=0 npm run dev:no-cg
```

## Environment

Use `.env.example` as the public shape. Keep real `.env` files private.

Important variables:

- `VNPLAYER_FRONTDOOR_URL`: stable public Worker URL for `/mcp`, when using a
  Cloudflare front door.
- `VNPLAYER_FRONTDOOR_UPDATE_SECRET`: secret used by the tunnel sidecar to update
  the current local origin.
- `VNPLAYER_WEB_HOST`: Vite reader UI bind host. Use `127.0.0.1` for local-only
  development or `0.0.0.0` to allow tailnet/local-network devices to open
  `http://<host-ip>:4173`.
- `VNPLAYER_WEB_PORT`: Vite reader UI port, default `4173`.
- `VNPLAYER_WEB_ALLOWED_HOSTS`: comma-separated hostnames accepted by Vite when
  using LAN hostnames or Tailscale MagicDNS, for example `s-mac-mini`.
- `VNPLAYER_WEBGPT_MCP_WRAPPER`: wrapper script used to drive the WebGPT browser
  seat. The default is this repo's `scripts/webgpt-local-wrapper.mjs`.
- `VNPLAYER_WEBGPT_TEXT_PROFILE_DIR`: logged-in browser profile root for the text
  lane.
- `VNPLAYER_WEBGPT_CG_PROFILE_DIR`: separate logged-in browser profile root for
  the CG lane.
- `VNPLAYER_TEXT_AUTHOR_PROVIDER`: text author backend, `webgpt` by default or
  `gemma4_local` for the Gemma llama.cpp OpenAI-compatible server.
- `VNPLAYER_GEMMA_BASE_URL`: Gemma API base URL, default
  `http://127.0.0.1:8080/v1`.
- `VNPLAYER_GEMMA_MODEL`: Gemma model id/alias sent to `/chat/completions`,
  default `gemma4-local`.
- `VNPLAYER_GEMMA_MAX_INPUT_TOKENS`: local stateless prompt budget, default
  `32768`.
- `VNPLAYER_GEMMA_MAX_OUTPUT_TOKENS`: generation cap sent as `max_tokens`,
  default `32768`.
- `VNPLAYER_GEMMA_TEMPERATURE`: Gemma sampling temperature. The default `0.9`
  favors story variation while `response_format` keeps the JSON boundary tight.

Default browser profile roots use `~/.vnplayer/...` so public configuration does
not leak private workspace names.

## WebGPT Connector

When VNplayer is used as a WebGPT MCP connector, keep the app local and expose
only the MCP connector through a stable front door:

```text
WebGPT MCP
  -> Cloudflare Worker /mcp front door
  -> cloudflared tunnel
  -> local VNplayer MCP/backend
  -> local SQLite
  -> local VNplayer reader app
```

If `VNPLAYER_FRONTDOOR_URL` and `VNPLAYER_FRONTDOOR_UPDATE_SECRET` are set,
`npm run dev:managed` can keep the public connector URL stable while the local
quick-tunnel origin rotates behind it.

Debug-only connector and JSON tools are hidden from the player surface. Open
`?debug=1` only for local inspection.

To ask the configured WebGPT browser lane to write one next turn:

```bash
npm run webgpt:author-once -- \
  --world-id <world-id> \
  --session-id <session-id> \
  --base-url http://127.0.0.1:4174
```

To ask the Gemma4 llama.cpp lane to write one next turn:

```bash
npm run gemma:author-once -- \
  --world-id <world-id> \
  --session-id <session-id> \
  --local-base-url http://127.0.0.1:4174 \
  --dispatch-id <dispatch-id> \
  --dispatch-token <dispatch-token>
```

WebGPT can use its browser chat as an auxiliary context window. `gemma4_local`
is deliberately stateless: every turn request carries the current VNplayer form,
recent visible history, active library docs, and compact library outline in a
fresh `gemma-stateless-current` prompt to the configured llama.cpp server.

The text lane and CG lane must use separate WebGPT browser seats:

```text
text: ~/.vnplayer/chatgpt-text-profile on CDP port 9228
cg:   ~/.vnplayer/chatgpt-cg-profile   on CDP port 9229
```

The CG lane is parallel display work. It must not block text progression, create
canon, rewrite prose, or influence ordinary choices.

## Agent Workflow

Codex-like agents should read `AGENTS.md` and this README before changing code.

Recommended setup:

1. Check the worktree with `git status --short --branch`.
2. Install dependencies with `npm install` if needed.
3. Use `.env.example` for variable names; do not read or print a real `.env`.
4. Start local-only development with
   `VNPLAYER_DEV_MCP_TUNNEL=0 npm run dev:no-cg`.
5. Start the supervised stack with `npm run dev:managed` when process cleanup,
   CG worker, or MCP tunnel behavior matters.
6. Validate source changes with `npm run build`.
7. Run `npm test` for schema, backend, or browser-flow changes.

Use Browser Use for localhost verification:

- navigate to `http://127.0.0.1:4173/`;
- confirm the entry screen, reader page, world/session restore, and visible
  error states;
- capture a screenshot when layout or rendering is the thing being checked.

Use Computer Use only when a real desktop browser state matters, such as a
logged-in Chrome/WebGPT connector seat. If Computer Use is unavailable, give the
operator exact manual steps instead of claiming that desktop state was checked.

## Validation

```bash
npm run build
npm test
```

Optional security scan when the scanner is installed:

```bash
grype dir:. --fail-on high
```

## Public Repository Hygiene

Do not commit:

- `.env` or `.env.*` except `.env.example`;
- `data/`, `.runtime/`, `tmp/`, local databases, logs, and screenshots;
- `docs/` local planning notes;
- browser profile directories;
- private deployment hostnames, tokens, local usernames, or local absolute paths.

Use placeholders such as:

- `https://vnplayer-frontdoor.<your-subdomain>.workers.dev`
- `${KEYCHAIN:vnplayer/frontdoor-origin-update-secret}`
- `~/.vnplayer/chatgpt-text-profile`
- `~/.vnplayer/chatgpt-cg-profile`

## Product Direction

VNplayer's center of gravity is simple:

- the LLM owns prose, pacing, ordinary choices, and scene meaning;
- the user owns steering through choices and freeform actions;
- the app owns world entry, reading, saving, replay, session restore,
  validation, and prompt handoff.

If backend behavior starts deciding what the story means, it has crossed the
line.

## License

Apache-2.0. See `LICENSE`.
