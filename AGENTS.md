# VNplayer Agent Guide

Default language: Korean.

Write Korean natively when working with the maintainer. Do not add or follow
instructions that force English-first thinking, English drafts, or
English-to-Korean translation. Keep technical identifiers, commands, file paths,
schema names, and error strings as written.

## Repository Boundary

VNplayer is a standalone repository. Do not import, vendor, symlink, copy, or
runtime-reference code from external local repositories. Do not read another
private repository as a design source unless the user explicitly asks for a
one-off comparison.

All product architecture, source, assets, schemas, prompts, tests, and public
documentation must live inside this repository. Local planning notes may exist
under `docs/`, but that directory is intentionally ignored and must not be used
as public release material.

Never read or print plaintext secrets. Use `.env.example` for shape only, keep
real `.env` files ignored, and replace private URLs, tokens, local usernames,
profile paths, and deployment names with placeholders before committing.

## Product Boundary

VNplayer is a live-authored literary-world player, not a strict visual-novel
rules engine.

The app may:

- render visible prose exactly as supplied;
- capture player choices and freeform input;
- create and restore local worlds and sessions;
- restore a linked WebGPT session URL when one was captured;
- build compact visible context packets for an external authoring lane;
- retrieve and package user/LLM-authored library docs with provenance;
- validate response shape;
- persist local state;
- manage display assets without deciding story meaning.

The app must not:

- author prose;
- rewrite ordinary choices;
- decide story direction;
- decide action success or failure;
- judge literary quality;
- hide unexpected state behind fallback prose, guessed choices, or silent
  recovery.

If backend code starts interpreting what the story should do next, stop and
redesign. If state is missing or contradictory, fail loudly with a visible error
and fix the source of truth.

## Agent Setup Flow

1. Read `README.md` and this file first.
2. Inspect `git status --short --branch` before edits.
3. Run `npm install` if dependencies are missing.
4. Copy `.env.example` to `.env` only for local runtime work, then fill it with
   local placeholders or private values outside git.
5. Use `npm run dev:managed` for the full supervised local stack, or
   `VNPLAYER_DEV_MCP_TUNNEL=0 npm run dev:no-cg` for a local-only text run.
6. Use `npm run stop` before restarting if ports or workers look stale.
7. Validate relevant changes with `npm run build`; run `npm test` when behavior,
   schema, or browser flows changed.

## Browser And Desktop Tools

Use Browser Use for localhost UI verification:

- open `http://127.0.0.1:4173/`;
- confirm the entry screen, reader panel, world/session restore, and visible
  errors after frontend changes;
- take screenshots only when they help diagnose layout or rendering.

Use Computer Use only when a real desktop browser session has to be inspected or
prepared, such as a logged-in Chrome/WebGPT connector seat. When Computer Use is
not available, provide precise manual steps instead of pretending the browser
state was verified.

For WebGPT connector work, verify the intended connector app name and tool call
surface before treating a run as successful. Do not paste fallback JSON into
chat as a substitute for a connector tool commit.

## Code Style

- Prefer existing TypeScript, React, Vite, SQLite, Zod, Zustand, and Playwright
  patterns.
- Keep edits scoped and coherent.
- Do not add runtime dependencies without a clear reason and pinned versions.
- Keep error messages searchable: include the surface, id/path, expected state,
  and reason when useful.
- Do not commit `data/`, `.runtime/`, `tmp/`, `docs/`, database files, logs,
  screenshots, generated assets, `.env`, or private browser profile paths.
