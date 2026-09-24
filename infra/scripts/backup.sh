#!/usr/bin/env bash
# Sauvegarde quotidienne des bases (litellm, portal, superset). Conservation locale 14 jours.
# Cron (root) : 30 2 * * * /opt/linagora-ia/scripts/backup.sh >> /var/log/linagora-ia-backup.log 2>&1
# Copie hors instance : à brancher sur OVH Object Storage (rclone ou s3cmd) — voir runbook, phase 7.
set -euo pipefail
cd /opt/linagora-ia
DEST=/var/backups/linagora-ia
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

for db in litellm portal superset; do
  docker compose exec -T postgres pg_dump -U postgres -Fc "$db" > "$DEST/${db}-${STAMP}.dump"
  echo "$(date -Is) dump $db OK ($(du -h "$DEST/${db}-${STAMP}.dump" | cut -f1))"
done
docker compose exec -T postgres pg_dumpall -U postgres --globals-only > "$DEST/globals-${STAMP}.sql"

find "$DEST" -type f -mtime +14 -delete
# Hook copie distante (décommenter une fois rclone configuré) :
# rclone copy "$DEST" ovh-s3:linagora-ia-backups --max-age 25h
