#!/usr/bin/env bash
# Nightly backup for the Hetzner compose stack: a Postgres dump plus the
# Paperclip data volume (uploads, agent homes, memory files), shipped with
# restic. Run from this directory on the host; see docs/deploy/hetzner.md.
set -euo pipefail

cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
. ./.env
set +a
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY must be set in .env}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD must be set in .env}"

staging="$(mktemp -d /var/tmp/paperclip-backup.XXXXXX)"
trap 'rm -rf "$staging"' EXIT

stamp="$(date -u +%Y%m%dT%H%M%SZ)"

# Custom-format dump: restorable with pg_restore, compressed, consistent.
docker compose exec -T db pg_dump -U paperclip -d paperclip -Fc >"$staging/paperclip-$stamp.dump"

# The data volume, read through a throwaway container so the server keeps running.
docker run --rm \
  -v paperclip_paperclip-data:/data:ro \
  -v "$staging":/out \
  alpine:3 tar -czf "/out/paperclip-data-$stamp.tar.gz" -C /data .

restic snapshots >/dev/null 2>&1 || restic init
restic backup --tag paperclip "$staging"
restic forget --tag paperclip --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
