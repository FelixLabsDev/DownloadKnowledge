#!/usr/bin/env bash
# Nightly backup. Takes a consistent snapshot of the live database (SQLite's
# VACUUM INTO, not a file copy), keeps 14 of them, and copies the snapshots
# and the media directory to S3 if DK_BACKUP_BUCKET is set in .env.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && set -a && . ./.env && set +a

KEEP=14
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
mkdir -p data/backups

docker exec dk dk backup "/data/backups/dk-$stamp.sqlite3" > /dev/null
gzip -f "data/backups/dk-$stamp.sqlite3"
echo "Snapshot: data/backups/dk-$stamp.sqlite3.gz ($(du -h "data/backups/dk-$stamp.sqlite3.gz" | cut -f1))"

# Keep the newest $KEEP snapshots.
ls -1t data/backups/dk-*.sqlite3.gz | tail -n +$((KEEP + 1)) | xargs -r rm --

if [ -n "${DK_BACKUP_BUCKET:-}" ]; then
  # --delete keeps S3 at the same 14 snapshots. Media is never deleted from S3 by this script.
  aws s3 sync data/backups "s3://$DK_BACKUP_BUCKET/db/" --delete --only-show-errors
  aws s3 sync data/media "s3://$DK_BACKUP_BUCKET/media/" --only-show-errors
  echo "Copied to s3://$DK_BACKUP_BUCKET"
else
  echo "DK_BACKUP_BUCKET is not set: the backup stayed on this server only."
fi
