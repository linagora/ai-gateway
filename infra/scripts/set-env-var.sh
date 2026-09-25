#!/usr/bin/env bash
# Renseigne une variable de /opt/linagora-ia/.env sans jamais afficher sa valeur ni la
# passer en argument de commande (invisible dans ps et dans l'historique du shell).
# Usage :
#   saisie masquée : ssh -t ia-host '/opt/linagora-ia/scripts/set-env-var.sh OPENROUTER_API_KEY'
#   depuis un flux : <commande qui produit la valeur> | ssh ia-host '/opt/linagora-ia/scripts/set-env-var.sh OVH_QWEN_API_KEY'
set -euo pipefail
cd "$(dirname "$0")/.."

var="${1:?usage : set-env-var.sh NOM_VARIABLE}"
[[ "$var" =~ ^[A-Z0-9_]+$ ]] || { echo "nom de variable invalide : $var" >&2; exit 1; }
grep -q "^${var}=" .env || { echo "variable absente de .env : $var" >&2; exit 1; }

if [ -t 0 ]; then
  read -rsp "Valeur de $var (masquée) : " val; echo
else
  IFS= read -r val || true
fi
[ -n "$val" ] || { echo "valeur vide : .env non modifié" >&2; exit 1; }

tmp="$(mktemp .env.XXXXXX)"
chmod 600 "$tmp"
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" == "${var}="* ]]; then printf '%s=%s\n' "$var" "$val"; else printf '%s\n' "$line"; fi
done < .env > "$tmp"
mv "$tmp" .env
echo "• $var renseignée"
