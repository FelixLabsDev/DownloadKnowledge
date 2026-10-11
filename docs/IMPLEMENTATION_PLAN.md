# DownloadKnowledge: implementation plan

This document is the full brief for building DownloadKnowledge. It was agreed with the owner in a design session on 2026-10-11. Decisions marked **Decided** are settled; do not reopen them without asking the owner. Anything marked **Verify** is a belief the plan relies on that you should check before depending on it.

## 1. What we are building

A personal spaced-repetition learning tool in the style of Anki, for one user, used from an Android phone and desktop browsers. Both stay in sync through a server the owner runs. The app keeps working with no network, for days if need be, and reconciles when the connection returns without losing or corrupting data.

Two requirements shape how the work is done:

1. **Everything is testable on the development machine before it touches the server.** Every slice ends with a local check, and the production Docker image must be runnable locally with one command.
2. **Once deployed, the server updates itself when code is pushed to `main` on GitHub.** No manual deploy steps after the one-time setup.

## 2. Decided scope

### In v1

- **Card model (Anki's).** A *note* holds fields. A *note type* defines the fields and one or more *templates*. Each template (or each cloze gap) generates one *card*; cards are what get scheduled. Built-in note types: Basic, Basic (and reversed card), Cloze. Templates are HTML with a shared CSS block per note type. Fields may contain images and audio.
- **Decks and folders.** A folder is a deck that has children (nested decks, as in Anki). Studying a deck includes everything beneath it.
- **Review.** Study what is due in a deck or folder. Per-deck daily limits (default 20 new, 200 reviews; a parent's limit caps its children). Cram mode: study a deck regardless of schedule without changing the schedule. Undo last review. Suspend a card.
- **Scheduling.** FSRS only, default parameters, desired retention per deck (default 90%). The study day rolls over at 04:00 local time.
- **Editing.** Rich-text field editor (bold, italic, lists, paste or attach an image, attach audio, a cloze button). Templates of existing note types editable as raw HTML/CSS.
- **Organisation.** Tags. A card browser with search. On desktop the browser is a table with bulk edit, move, tag, suspend and delete.
- **Import.** Anki `.apkg` with media and deck hierarchy, with a checkbox to keep existing scheduling and review history. CSV/TSV import for hand-made lists.
- **Export.** A full backup as JSON/CSV. Not `.apkg`.
- **Dashboard.** Due forecast (today and the next 30 days), retention over time, review-activity heatmap with streak, per-deck counts by state (new, learning, review/mature, suspended), and a storage readout (local and server). The owner asked for this to look polished; treat visual quality here as a requirement.
- **Views.** Mobile opens on the due list, with a large tap/swipe review screen and a quick-add form. Desktop can do everything and is the fuller interface. Mobile should still do all or most things.
- **Agent access.** A command-line tool on the server, run over SSH, that lets a coding agent list, search, create, edit, move and delete decks and cards. A skill file in this repo teaches agents to use it.

### Out of v1

Sharing or multiple users, study reminders, a native app shell (Capacitor), `.apkg` export, creating note types from scratch, a visual template designer, JavaScript inside templates, filtered study by tag or state, typed-answer mode, FSRS parameter optimisation.

## 3. Architecture

### Stack (Decided)

| Layer | Choice |
|---|---|
| Language and layout | TypeScript, pnpm workspaces monorepo |
| Client | React + Vite, installable PWA (`vite-plugin-pwa`), Tailwind + shadcn/ui |
| Client data | SQLite in the browser, persisted in OPFS, accessed from a Web Worker |
| Server | Node + Hono, one process, one Docker container |
| Server data | SQLite file on a Docker volume (not Postgres; the server has about 200 MB of free memory) |
| Schema and queries | Drizzle, with one schema definition shared by client and server |
| Scheduler | `ts-fsrs`, run on the client |
| Tests | Vitest for logic, Playwright for the browser, including offline scenarios |
| Deploy | Image built in GitHub Actions, pushed to GHCR, pulled by the server |

### Repository layout

```
packages/core     domain model, schema, scheduler wrapper, card generation,
                  template rendering, sync logic, importers. No DOM, no Node APIs.
apps/web          the PWA
apps/server       Hono API, sync endpoints, media, auth, and the `dk` CLI
deploy/           Dockerfile, compose file, server-side scripts, Caddy snippet
skills/dk-cards/  the agent skill (SKILL.md)
docs/             this plan, later a glossary and decision records
```

`packages/core` must stay free of platform APIs so the same code runs in the browser worker, in the server and in the CLI. Database access goes through a small storage interface with two implementations (browser, Node). This is also what makes a later native shell possible.

### Local data in the browser

- Use the official `@sqlite.org/sqlite-wasm` build with the OPFS "SAH pool" VFS, inside a dedicated worker. **Verify** that this VFS works without cross-origin isolation headers and persists across restarts on Android Chrome. This is the riskiest assumption in the plan; slice 1 starts by proving it.
- The SAH pool VFS allows one connection, so only one tab can own the database. Use the Web Locks API to elect an owner tab; other tabs either proxy through it or show "open in another tab". Pick the simpler option that works and document it.
- Call `navigator.storage.persist()` on first run to ask the browser not to evict the data.
- Fallback if OPFS SQLite proves unworkable: IndexedDB behind the same storage interface. Ask the owner before switching.

### Data model

Tables, all with `id` (UUIDv7 generated on the client), `modified_at` (client clock, ms), `deleted_at` (nullable, soft delete) and `server_version` (set by the server):

- `decks` (name, parent id, limits, desired retention)
- `note_types` (name, kind: standard or cloze, fields, CSS)
- `templates` (note type id, name, front HTML, back HTML, ordinal)
- `notes` (note type id, field values, tags)
- `cards` (note id, template ordinal or cloze index, deck id, FSRS state: due, stability, difficulty, reps, lapses, state, last review; suspended flag)
- `review_log` (card id, rating, reviewed at, state before, elapsed and scheduled days, duration, device id). Insert-only, never updated.
- `media` (sha256 hash as id, filename, mime type, size)
- `agent_batches` (id, created at, description), referenced by notes the agent created

Soft-deleted rows are purged 30 days after deletion, on the server, and the purge propagates as a hard-delete instruction.

### Sync protocol (Decided: custom, thin)

- The UI reads and writes only the local database. Every local write also appends to a local `outbox` table in the same transaction.
- **Push.** The client sends outbox entries in batches to `POST /api/sync/push`. Each entry carries the row and its id. The server applies the batch in one transaction and must be idempotent: resending a batch after a lost response changes nothing.
- **Versioning.** The server keeps one monotonically increasing counter. Every accepted change stamps the row with the next value as `server_version`.
- **Pull.** The client calls `GET /api/sync/pull?since=<last version seen>`, paginated, and applies the rows. It stores the highest version it has applied.
- **Conflicts.** For mutable rows, the row with the later `modified_at` wins; ties break on device id. For `review_log`, there are no conflicts: rows are only ever inserted, and a duplicate id is ignored.
- **Known limitation, accepted by the owner.** If the same card is reviewed on two offline devices, both review-log entries are kept but the card's scheduling state comes from whichever review was later. Do not build log-replay reconciliation in v1.
- **Media.** Files are content-addressed by sha256. The client uploads a file only if the server does not have that hash, and downloads lazily, caching in OPFS. Media sync is separate from row sync and must never block reviewing.
- **Triggers.** Sync on app start, on regaining connectivity, after each review session, and on a timer while open. Show sync state in the UI (synced, pending count, offline, error).

Sync is where data-loss bugs occur. It needs tests that run two or three simulated clients against a real server instance in-process and cover: lost responses and retries, duplicate sends, out-of-order batches, interleaved edits to the same row, delete versus edit, a client that has been offline for a long time, and a pull interrupted halfway.

### Server

- Hono API, serving the built web app as static files from the same container, so there is one origin and no CORS.
- **Auth.** One account. The password hash (argon2id) comes from an environment variable; there is no registration endpoint. Login sets a long-lived, httpOnly, Secure, SameSite=Lax session cookie, one session per device, revocable. Rate-limit login attempts.
- `GET /api/health` returns status and the git commit the image was built from. The deploy check depends on this.
- SQLite in WAL mode with a busy timeout, because the CLI writes from a second process.

### Agent tool (Decided: over SSH, not a public API)

- A CLI named `dk` ships in the server image and writes through the same `packages/core` code as the API, inside a transaction that stamps `server_version`. This is why agents must never write rows with raw SQL: an unstamped row would never reach any device, and a note must generate its cards correctly.
- Invoked as `ssh linux-machine docker exec dk dk <command>`. Commands cover decks (list, create, rename, move, delete), notes and cards (add in bulk from JSON on stdin, search, edit, move, suspend, delete) and batches (list, undo).
- All commands print JSON so an agent can parse results.
- Safety nets: every run that creates notes records an `agent_batches` row, and the notes carry an `agent` tag and the batch id; deletes are soft. `dk batch undo <id>` reverses one batch. Duplicate notes (same first field in the same deck) are skipped and reported unless `--allow-duplicates` is passed.
- The skill at `skills/dk-cards/SKILL.md` explains the commands, the JSON shapes for each built-in note type, and how to write good cards (one fact per card, cloze for lists). Tell the owner how to install it for their agent.

## 4. Local development and testing

The development machine is Windows 11 with Node 24, pnpm 9 and Docker Desktop. All of the following must work there.

| Command | Does |
|---|---|
| `pnpm dev` | Runs the web app (Vite) and the server together with hot reload; the server uses a SQLite file under `./.data/` |
| `pnpm test` | Vitest across all packages, including the multi-client sync tests |
| `pnpm test:e2e` | Playwright against a locally started server, including going offline and coming back |
| `pnpm typecheck`, `pnpm lint` | Static checks |
| `docker compose -f deploy/compose.yml -f deploy/compose.local.yml up --build` | Builds and runs the exact production image locally |

To test the PWA on the Android phone before deploying: service workers and OPFS need a secure context, and `localhost` counts as one. Use Chrome's USB port forwarding (`chrome://inspect` → Port forwarding) so the phone reaches the dev machine as `localhost`. Document the steps in the README.

A slice is not done until its checks pass locally. Nothing is deployed to the server before slice 2, and from then on nothing reaches the server except through a push to `main`.

## 5. Deployment

### The server, as surveyed on 2026-10-11

- SSH alias `linux-machine`, user `ubuntu` (in the `docker` and `sudo` groups). AWS EC2 t3.small, eu-west-1, Ubuntu 22.04, 2 vCPU.
- **Memory is the constraint**: 1.9 GB total, about 210 MB available, 3.6 GB already in swap. Disk: 49 GB, 7.4 GB free.
- Caddy 2.10 runs as a systemd service from the single file `/etc/caddy/Caddyfile`, which already has 16 site blocks on `*.felixlabs.net`. Other apps live under `/home/ubuntu/apps/<name>`.
- Docker and Compose are installed. The AWS CLI is installed and the instance has an IAM role attached (**Verify** what the role may do before relying on it for S3).
- Many ports are in use on localhost (3000, 3001, 5005, 5051–5093, 5150, 5151, 8001 among them). Check for a free one at deploy time.

This server runs the owner's other services. Do not restart, reconfigure or stop anything that is not ours. Changing `/etc/caddy/Caddyfile` affects every site on the box: back the file up, show the owner the exact block to be added, get their go-ahead, validate with `caddy validate`, then reload (not restart).

### Rules that follow from the memory constraint

- Never build images or run `pnpm install` on the server. It only pulls.
- Set a memory limit on the container (start at 256 MB) so a fault in our app cannot take the box down.
- Keep the image small: multi-stage build, production dependencies only.

### Continuous deployment (Decided: pull-based)

The requirement: a push to `main` updates the server with no manual step.

1. **GitHub Actions, on push to `main`**: install, typecheck, lint, test, build the web app, build the Docker image with the commit SHA baked in, and push it to GHCR as `:latest` and `:<sha>`. If any check fails, no image is pushed and the server keeps running the previous version.
2. **On the server**: a systemd timer runs every minute in `/home/ubuntu/apps/downloadknowledge`, executing `docker compose pull` followed by `docker compose up -d`. Compose recreates the container only when the image has changed. No inbound access from GitHub is needed and no SSH key is stored in GitHub.
3. **Verification, back in the Actions run**: after pushing the image, poll `https://<domain>/api/health` for up to five minutes until it reports the new commit SHA. Fail the workflow if it does not, so a broken deploy is visible on GitHub.
4. **Schema migrations** run automatically when the server starts, before it accepts requests. Before migrating, the server copies the database file to a timestamped backup beside it. Migrations must be backward compatible with the previous client version, because phones may run an older cached app for a while.
5. **Rollback**: pin the compose file to a previous `:<sha>` tag. Document the command.

The client also needs an update path: the service worker detects a new version and the app shows a "new version available, reload" prompt. Never reload automatically during a review session.

### One-time setup (slice 2), and who does what

| Item | Who |
|---|---|
| Choose the subdomain and create the DNS record at Namecheap pointing to the EC2 address | Owner |
| Choose the account password; store its hash in `/home/ubuntu/apps/downloadknowledge/.env` (mode 600) | Owner supplies, agent installs |
| A GitHub token with `read:packages` on the server so it can pull the private image (`docker login ghcr.io`) | Owner creates, agent installs |
| Compose file, `.env`, data and media volumes, systemd timer | Agent |
| Caddy site block for the subdomain, reverse-proxying to the container's localhost port | Agent, after the owner approves the exact change |
| S3 bucket for backups, and confirmation that the instance role can write to it | Owner, or agent if the role allows it |

### Backups

A nightly systemd timer on the server takes a consistent snapshot of the database (SQLite's online backup, not a file copy of a live database), then syncs the snapshot and the media directory to the S3 bucket. Keep 14 daily snapshots. Write and test the restore procedure once; an untested backup does not count.

## 6. Build order

Each slice ends in something the owner can use, and is checked locally before the next begins.

### Slice 1: local-only app in the browser

1. Scaffold the monorepo, tooling, CI workflow for checks (no deploy yet), and a README with the commands from section 4.
2. **Spike first:** SQLite in OPFS in a worker, with a trivial screen that writes and reads a row. Confirm it survives a restart in desktop Chrome and on the Android phone via port forwarding, with the network off. Report the result to the owner before building on it.
3. Schema, storage interface, built-in note types, card generation (including cloze parsing), template rendering.
4. Decks and folders, the card editor, the browser with search, tags.
5. FSRS scheduling, the review screen, limits, day rollover, undo, suspend, cram.
6. Mobile and desktop layouts; installable PWA with offline app shell.

Done when: the owner can create decks and cards and review them over several simulated days, entirely offline, on desktop and phone. Scheduler behaviour is covered by unit tests with a controllable clock.

### Slice 2: server, login, sync, deployment

1. Server skeleton, auth, health endpoint.
2. Sync push and pull, outbox, conflict rules, sync status in the UI, and the multi-client test suite from section 3.
3. Media upload and download.
4. Dockerfile and compose files; run the production image locally and test two browser profiles syncing through it, including Playwright offline scenarios.
5. One-time server setup, continuous deployment and backups, per section 5.

Done when: a card created on the desktop appears on the phone and vice versa; reviews made in airplane mode arrive after reconnecting; a trivial commit pushed to `main` is live within a few minutes with a green Actions run; a restore from backup has been performed once.

### Slice 3: import and export

1. `.apkg` import. The file is a zip containing a SQLite collection and media. **Verify** against real files: older exports hold `collection.anki2` or `collection.anki21` and a JSON media map; newer ones hold a zstd-compressed `collection.anki21b` with a protobuf media map and zstd-compressed media. Support both. Parse in the browser, in a worker, with progress reporting; large decks must not freeze the UI or exhaust memory on the phone.
2. Map Anki note types, templates, decks (`::` separators become nesting), tags and media. Optionally map scheduling state and review history; when Anki's cards use SM-2 state, convert or reset to new, and say which in the import summary.
3. Templates using features we do not support (JavaScript, special fields, type-in-the-answer) must degrade visibly, not silently.
4. CSV/TSV import with column mapping. JSON/CSV backup export.

The owner will supply one or two real decks as test cases. Done when those import correctly and review well on the phone.

### Slice 4: dashboard and agent tool

1. Dashboard panels from section 2, computed locally from the review log. Follow the repo's data-visualisation guidance if a skill for it is available; it must work in light and dark themes and on a phone.
2. The `dk` CLI, batch tracking and undo, with tests.
3. The skill file, tried end to end: an agent adds a batch of cards over SSH and they appear on the phone after a sync.

## 7. Working agreements

- Record the terms from section 2 (note, card, note type, template, deck, review log) in a glossary file at the start, and use them consistently in code.
- Test-first for `packages/core`: scheduler wrapper, card generation, cloze parsing, sync, importers.
- Commit in small steps on `main` during slice 1. From slice 2 on, `main` deploys, so work on branches and merge only when checks pass.
- Ask the owner before: changing a decision in this document, touching anything on the server that is not ours, changing the Caddy config, or spending money on AWS.
- Report the server's disk headroom whenever media-heavy imports are tested; 7.4 GB was free at survey time.
