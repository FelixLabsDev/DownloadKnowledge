# Deployment

How DownloadKnowledge gets onto the server and stays up to date. Background and constraints are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) §5.

## How an update reaches the server

1. A push to `main` runs `.github/workflows/deploy.yml`: typecheck, lint, unit tests, browser tests. If any fail, it stops and the server keeps running what it has.
2. The workflow builds the image with the commit SHA baked in and pushes `ghcr.io/felixlabsdev/downloadknowledge:latest` and `:<sha>`.
3. On the server, `dk-update.timer` runs `docker compose pull` and `docker compose up -d` every minute. Compose recreates the container only if the image changed. On start the server snapshots the database, runs any schema migrations, then listens.
4. The workflow polls `https://<domain>/api/health` for up to five minutes until it reports the new commit, and fails if it does not. This step is skipped until the repository variable `DK_DOMAIN` is set.

The server never builds anything and GitHub never connects to the server.

## Run the production image on the development machine

```
docker compose -f deploy/compose.yml -f deploy/compose.local.yml up --build
```

Open http://localhost:5180 and sign in with `local-password`. To run the browser tests against it:

```
cd apps/web
DK_E2E_URL=http://localhost:5180 DK_E2E_PASSWORD=local-password pnpm exec playwright test --workers=4
```

(PowerShell: set `$env:DK_E2E_URL` and `$env:DK_E2E_PASSWORD` first.) Remove it with `docker compose -f deploy/compose.yml -f deploy/compose.local.yml down -v`.

## One-time server setup

Nothing below has been done yet. Items marked **Owner** need the owner; the rest an agent can do over `ssh linux-machine`. Do not restart, stop or reconfigure anything else on that server.

1. **Owner:** choose the subdomain and create the DNS record at Namecheap pointing to the EC2 address.
2. **Owner:** create a GitHub token (classic, scope `read:packages` only) so the server can pull the private image.
3. **Owner:** choose the account password.
4. Check memory and disk headroom (`free -m`, `df -h /`) and pick a free port (`ss -ltn | grep 5180`).
5. Create the app directory and log in to GHCR:
   ```
   mkdir -p /home/ubuntu/apps/downloadknowledge/data/backups
   cd /home/ubuntu/apps/downloadknowledge
   echo "<token>" | docker login ghcr.io -u <github user> --password-stdin
   ```
   `data/` must be owned by uid 1000 (the `ubuntu` user), which is the user the container runs as.
6. Copy `deploy/compose.yml`, `deploy/server/backup.sh`, `deploy/server/restore.sh` into that directory, and `deploy/.env.example` as `.env`. Make the scripts executable.
7. Generate the password hash and put it in `.env` (single-quoted), then `chmod 600 .env`:
   ```
   docker run --rm -i ghcr.io/felixlabsdev/downloadknowledge:latest dk hash-password <<< 'the password'
   ```
8. Start it and check it: `docker compose up -d`, then `curl http://127.0.0.1:5180/api/health`.
9. Install the timers:
   ```
   sudo cp dk-update.service dk-update.timer dk-backup.service dk-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now dk-update.timer dk-backup.timer
   ```
10. **Caddy (needs the owner's go-ahead on the exact text).** The block to add is in `deploy/server/Caddyfile.snippet`.
    ```
    sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%F)
    # add the block, then:
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy      # reload, never restart
    ```
11. In the GitHub repository settings, add the variable `DK_DOMAIN` with the subdomain. From now on a failed deploy fails the workflow.
12. **Backups to S3.** Check what the instance role may do (`aws sts get-caller-identity`, then try `aws s3 ls`). **Owner** creates the bucket (or approves creating it; it costs money). Put its name in `.env` as `DK_BACKUP_BUCKET`, run `./backup.sh` once by hand, and confirm the files are in the bucket.
13. **Test the restore once.** Run `./restore.sh` with last night's snapshot and confirm the app still shows your cards. A backup that has never been restored does not count.

## Rollback

In `/home/ubuntu/apps/downloadknowledge/.env` set `DK_TAG=<sha of a good commit>`, then:

```
docker compose up -d
```

The update timer keeps pulling that tag, so the server stays pinned until `DK_TAG` goes back to `latest`. Schema migrations are additive, so an older image can read a database a newer one migrated.

## Operations

| Task | Command (on the server, in the app directory) |
|---|---|
| Logs | `docker logs --tail 100 -f dk` |
| Which commit is live | `curl -s http://127.0.0.1:5180/api/health` |
| Update timer activity | `systemctl list-timers dk-*` and `journalctl -u dk-update -n 20` |
| Back up now | `./backup.sh` |
| Restore | `./restore.sh data/backups/<file>.sqlite3.gz` |
| Agent CLI | `docker exec -i dk dk --help` |
| Memory in use | `docker stats dk --no-stream` (limit is 256 MB; about 25 MB idle) |

Soft-deleted rows are purged 30 days after deletion, at server start and daily. Before any schema migration the server writes `data/dk.sqlite3.before-migration-<time>`; delete old ones by hand when disk gets tight.
