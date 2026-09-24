#!/usr/bin/env bash
# Crée /opt/linagora-ia/.env à partir de .env.example et remplace chaque __GENERATE__
# par un secret aléatoire. Idempotent : ne remplace JAMAIS un secret déjà généré.
# N'affiche aucun secret.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { cp .env.example .env; echo "• .env créé depuis .env.example"; }
chmod 600 .env

tmp="$(mktemp)"
while IFS= read -r line; do
  if [[ "$line" =~ ^([A-Z0-9_]+)=__GENERATE__$ ]]; then
    var="${BASH_REMATCH[1]}"
    val="$(openssl rand -hex 32)"
    [ "$var" = "LITELLM_MASTER_KEY" ] && val="sk-${val}"
    printf '%s=%s\n' "$var" "$val" >> "$tmp"
    echo "• secret généré : $var"
  else
    printf '%s\n' "$line" >> "$tmp"
  fi
done < .env
cat "$tmp" > .env && rm -f "$tmp"
chmod 600 .env

echo "• Valeurs encore à fournir (__ASK__) :"
grep -E '__ASK' .env | cut -d= -f1 | sed 's/^/    - /' || echo "    (aucune)"
