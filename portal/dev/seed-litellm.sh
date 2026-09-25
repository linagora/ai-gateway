#!/usr/bin/env bash
# Données de démonstration pour le LiteLLM de dev : 4 modèles à réponses simulées (aucun appel externe),
# tarifés en euros, et une équipe « R&D » sans membre. Idempotent. Valeurs FACTICES.
#   ./dev/seed-litellm.sh
set -euo pipefail
B="${LITELLM_BASE_URL:-http://127.0.0.1:54400/admin}"
H=(-H "Authorization: Bearer ${LITELLM_MASTER_KEY:-sk-dev-master-key}" -H "Content-Type: application/json")

model() { # nom, niveau, hébergement, prix entrée, prix sortie (€ par jeton), fournisseur, éditeur, capacités, hébergeurs (JSON), zone[, contexte]
  local info id
  info=$(jq -n --arg l "$2" --arg h "$3" --arg f "$6" --arg e "$7" --argjson c "$8" --argjson hb "$9" --arg z "${10}" --argjson ctx "${11:-128000}" \
    '{data_level: $l, hosting: $h, pricing_currency: "EUR", max_input_tokens: $ctx, fournisseur: $f, editeur: $e, capacites: $c, hebergeurs: $hb, zone: $z}')
  id=$(curl -fsS "${H[@]}" "$B/model/info" | jq -r --arg n "$1" 'first(.data[] | select(.model_name == $n) | .model_info.id) // empty')
  if [[ -n "$id" ]]; then
    curl -fsS "${H[@]}" -X PATCH "$B/model/$id/update" -d "$(jq -n --argjson i "$info" '{model_info: $i}')" >/dev/null
    echo "• modèle $1 : déjà présent, informations mises à jour"
    return
  fi
  curl -fsS "${H[@]}" -X POST "$B/model/new" -d "$(jq -n --arg n "$1" --argjson i "$4" --argjson o "$5" --argjson info "$info" '{
    model_name: $n,
    litellm_params: {model: "openai/gpt-4o-mini", api_key: "sk-factice", mock_response: "Réponse simulée", input_cost_per_token: $i, output_cost_per_token: $o},
    model_info: $info
  }')" >/dev/null
  echo "• modèle $1 ($2) : créé"
}

# Faits techniques comme les déclare la passerelle de production : fournisseur, éditeur, capacités, hébergeurs, zone.
model dev-public N1 HORS_UE 0.0000001 0.0000004 OpenRouter "Moonshot AI" '["images","raisonnement"]' '["Fireworks"]' monde
model dev-interne N2 UE 0.0000002 0.0000006 OpenRouter "Mistral AI" '["images"]' '["Mistral"]' UE
model dev-confidentiel N3 INTERNE 0.0000004 0.0000027 OVHcloud "Alibaba (Qwen)" '["images","raisonnement"]' '["OVHcloud"]' UE 262144
model dev-experimental EXP HORS_UE 0.0000001 0.0000004 Typesafe Typesafe '[]' '["Typesafe"]' monde

MODELS='["dev-public", "dev-interne", "dev-confidentiel", "dev-experimental"]'

TEAM_ID=$(curl -fsS "${H[@]}" "$B/team/list" | jq -r 'first(.[] | select(.team_alias == "R&D") | .team_id) // empty')
if [[ -n "$TEAM_ID" ]]; then
  curl -fsS "${H[@]}" -X POST "$B/team/update" -d "$(jq -n --arg t "$TEAM_ID" --argjson m "$MODELS" '{team_id: $t, models: $m}')" >/dev/null
  echo "• équipe R&D : déjà présente, modèles mis à jour"
else
  curl -fsS "${H[@]}" -X POST "$B/team/new" -d "$(jq -n --argjson m "$MODELS" '{team_alias: "R&D", models: $m}')" >/dev/null
  echo "• équipe R&D : créée"
fi
