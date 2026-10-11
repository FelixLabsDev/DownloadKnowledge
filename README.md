# DownloadKnowledge

A personal spaced-repetition learning tool in the style of Anki, for one user, on an Android phone and desktop browsers. It works offline and (from slice 2) syncs through a self-hosted server.

- The full brief: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- The vocabulary used in code and UI: [docs/GLOSSARY.md](docs/GLOSSARY.md)
- Decisions made while building: [docs/DECISIONS.md](docs/DECISIONS.md)

## Status

Slice 1 (local-only app in the browser) is built. Slices 2–4 (server and sync, import/export, dashboard and agent tool) are not.

## Requirements

Node 24, pnpm 9. Docker Desktop is needed from slice 2.

```
pnpm install
pnpm --filter @dk/web exec playwright install chromium   # once, for the browser tests
```

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Runs the web app at http://localhost:5173 with hot reload |
| `pnpm test` | Unit tests (Vitest) across all packages |
| `pnpm test:e2e` | Browser tests (Playwright) against the production build, including a browser restart with the network off |
| `pnpm typecheck`, `pnpm lint` | Static checks |
| `pnpm build` | Production build of the web app into `apps/web/dist` |

`pnpm test:e2e` builds the app and serves it on port 4173 by itself. The service worker (offline app shell) only exists in the production build, not under `pnpm dev`; to try it by hand run `pnpm --filter @dk/web build` and `pnpm --filter @dk/web preview`.

## Layout

```
packages/core          domain model, schema, scheduler wrapper, card generation, template rendering.
                       No DOM, no Node APIs (enforced by lint).
packages/storage-node  SQLite driver for Node (node:sqlite), used by tests and later the server and CLI
apps/web               the PWA
apps/server            (slice 2) API, sync, media, auth, the dk CLI
deploy/                (slice 2) Dockerfile, compose files, server-side scripts
skills/dk-cards/       (slice 4) the agent skill
```

## Testing on the Android phone before deploying

Service workers and OPFS storage need a secure context. `localhost` counts as one, so make the phone reach the dev machine as `localhost`:

1. On the phone: Settings → Developer options → enable USB debugging. Connect it by USB.
2. On the desktop, in Chrome, open `chrome://inspect/#devices`. Accept the prompt on the phone; it appears in the list.
3. Click **Port forwarding…**, add `5173` → `localhost:5173` (and `4173` → `localhost:4173` for the production build), tick **Enable port forwarding**.
4. Run `pnpm dev` (or build and `preview` for the installable, offline version).
5. On the phone, open Chrome at `http://localhost:5173` (or `:4173`).

To check that storage survives: Settings → Storage self-test → **Write a test row**, close Chrome from the recent-apps list, turn on airplane mode, reopen the page (use the `:4173` build so the app shell is cached). The row should still be listed.

## How the browser stores data

The collection is a SQLite database (the official `@sqlite.org/sqlite-wasm` build) kept in the browser's private file system (OPFS) and used from a Web Worker. Only one tab can hold the database, so a second tab shows "Open in another tab" and takes over when the first closes. Media files are stored beside it in OPFS, named by content hash.
