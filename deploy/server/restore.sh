#!/usr/bin/env bash
# Restores the database from a snapshot made by backup.sh.
#
#   ./restore.sh data/backups/dk-2026-10-12T033000Z.sqlite3.gz
#   ./restore.sh s3://bucket/db/dk-2026-10-12T033000Z.sqlite3.gz
#
# The current database is kept beside the restored one, renamed, never deleted.
# Media: aws s3 sync s3://bucket/media/ data/media/
set -euo pipefail
cd "$(dirname "$0")"
src=${1:?Usage: ./restore.sh <snapshot.sqlite3.gz or s3:// url>}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [[ $src == s3://* ]]; then
  aws s3 cp "$src" "$tmp/snapshot.gz" --only-show-errors
else
  cp "$src" "$tmp/snapshot.gz"
fi
gunzip "$tmp/snapshot.gz"

# Refuse a snapshot that is not a healthy database.
check=$(docker run --rm -v "$tmp:/restore:ro" --entrypoint node "$(docker inspect dk --format '{{.Config.Image}}')"   -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/restore/snapshot',{readOnly:true});console.log(d.prepare('PRAGMA integrity_check').get().integrity_check, d.prepare('SELECT count(*) n FROM cards').get().n)")
echo "Snapshot check: $check (integrity, card count)"
[[ $check == ok* ]] || { echo "The snapshot failed its integrity check; nothing was changed."; exit 1; }

docker compose stop dk
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
for f in dk.sqlite3 dk.sqlite3-wal dk.sqlite3-shm; do
  [ -e "data/$f" ] && sudo mv "data/$f" "data/$f.replaced-$stamp"
done
sudo install -o 1000 -g 1000 -m 644 "$tmp/snapshot" data/dk.sqlite3
docker compose start dk
sleep 3
docker exec dk wget -qO- http://127.0.0.1:8787/api/health && echo
echo "Restored. The previous database is data/dk.sqlite3.replaced-$stamp"
echo "Devices keep their own copies: anything they changed after the snapshot is pushed again on their next sync."
