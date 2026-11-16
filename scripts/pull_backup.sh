#!/bin/sh
# Off-Railway backup of the hosted CRM: downloads a full JSON export over HTTPS (token auth) and keeps the last 14.
# Restore = POST the file to /api/sync/restore on an empty database with ALLOW_RESTORE=1 (see README).
# Suggested nightly cron on the box:  15 2 * * *  ./scripts/pull_backup.sh >> ./backups/backup.log 2>&1
set -eu
cd "$(dirname "$0")/.."
URL=$(node -e 'console.log(require("./.remote-sync.json").url)')
mkdir -p backups && chmod 700 backups
umask 077
OUT="backups/crm-$(date +%Y%m%d-%H%M).json"
curl -sf -m 600 -H "Authorization: Bearer $(cat .railway-sync-token)" "$URL/api/sync/export" -o "$OUT.part"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=Object.fromEntries(Object.entries(j.tables).map(([k,v])=>[k,v.length]));if(!c.properties)throw new Error("export has no properties");console.log(new Date().toISOString(),"backup ok",JSON.stringify(c))' "$OUT.part"
mv "$OUT.part" "$OUT" && chmod 600 "$OUT" && gzip -f "$OUT"
ls -1t backups/crm-*.json.gz | tail -n +15 | xargs -r rm -f
