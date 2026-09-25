#!/usr/bin/env bash
# Installe la tâche quotidienne du portail (spécification #14 : rappels J-3 et J-7, expirations). Idempotent.
# - Jeton PORTAL_TASK_TOKEN : ajouté à .env et généré sur le serveur par gen-secrets.sh, jamais affiché.
# - Cron à 7 h, heure de Paris : le serveur est en UTC et le cron de Debian ignore CRON_TZ ; il passe à 5 h
#   et 6 h UTC, et une garde ne laisse agir que le passage de 7 h à Paris (heure d'été comme d'hiver).
# Usage (puis recréer le portail pour qu'il lise le jeton) :
#   sudo /opt/linagora-ia/scripts/installer-tache-quotidienne.sh
#   cd /opt/linagora-ia && docker compose --profile portal up -d portal
set -euo pipefail
cd "$(dirname "$0")/.."
UTILISATEUR="${SUDO_USER:-linagora}"

grep -q '^PORTAL_TASK_TOKEN=' .env || echo 'PORTAL_TASK_TOKEN=__GENERATE__' >> .env
./scripts/gen-secrets.sh > /dev/null
chown "$UTILISATEUR" .env
echo "• jeton de la tâche : $(grep -c '^PORTAL_TASK_TOKEN=.\+' .env) défini, $(grep -c '^PORTAL_TASK_TOKEN=__GENERATE__' .env) à générer"

install -d -o "$UTILISATEUR" logs
cat > /etc/cron.d/linagora-ia-portail <<CRON
# Tâche quotidienne du portail Linagora (rappels, expirations) : 7 h, heure de Paris. Journal : logs/taches.log
SHELL=/bin/bash
0 5,6 * * * $UTILISATEUR [ "\$(TZ=Europe/Paris date +\%H)" = "07" ] && cd /opt/linagora-ia && docker compose exec -T portal node -e "fetch('http://127.0.0.1:3000/api/taches/quotidienne',{method:'POST',headers:{authorization:'Bearer '+process.env.PORTAL_TASK_TOKEN}}).then(async r=>{console.log(new Date().toISOString(),r.status,await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(new Date().toISOString(),e.message);process.exit(1)})" >> /opt/linagora-ia/logs/taches.log 2>&1
CRON
chmod 644 /etc/cron.d/linagora-ia-portail
echo "• cron installé : /etc/cron.d/linagora-ia-portail"
