#!/usr/bin/env bash
# Données de démonstration pour le LiteLLM de dev : 4 modèles à réponses simulées (aucun appel externe),
# tarifés en euros, et une équipe « R&D » sans membre. Idempotent. Valeurs FACTICES.
#   ./dev/seed-litellm.sh
set -euo pipefail
B="${LITELLM_BASE_URL:-http://127.0.0.1:54400/admin}"
H=(-H "Authorization: Bearer ${LITELLM_MASTER_KEY:-sk-dev-master-key}" -H "Content-Type: application/json")

model() { # nom, niveau, hébergement, prix entrée, prix sortie (€ par jeton)
  if curl -fsS "${H[@]}" "$B/model/info" | jq -e --arg n "$1" '.data[] | select(.model_name == $n)' >/dev/null; then
    echo "• modèle $1 : déjà présent"
    return
  fi
  curl -fsS "${H[@]}" -X POST "$B/model/new" -d "$(jq -n --arg n "$1" --arg l "$2" --arg h "$3" --argjson i "$4" --argjson o "$5" '{
    model_name: $n,
    litellm_params: {model: "openai/gpt-4o-mini", api_key: "sk-factice", mock_response: "Réponse simulée", input_cost_per_token: $i, output_cost_per_token: $o},
    model_info: {data_level: $l, hosting: $h, pricing_currency: "EUR", max_input_tokens: 128000}
  }')" >/dev/null
  echo "• modèle $1 ($2) : créé"
}

model dev-public N1 HORS_UE 0.0000001 0.0000004
model dev-interne N2 UE 0.0000002 0.0000006
model dev-confidentiel N3 INTERNE 0.0000004 0.0000027
model dev-experimental EXP HORS_UE 0.0000001 0.0000004

MODELS='["dev-public", "dev-interne", "dev-confidentiel", "dev-experimental"]'

TEAM_ID=$(curl -fsS "${H[@]}" "$B/team/list" | jq -r 'first(.[] | select(.team_alias == "R&D") | .team_id) // empty')
if [[ -n "$TEAM_ID" ]]; then
  curl -fsS "${H[@]}" -X POST "$B/team/update" -d "$(jq -n --arg t "$TEAM_ID" --argjson m "$MODELS" '{team_id: $t, models: $m}')" >/dev/null
  echo "• équipe R&D : déjà présente, modèles mis à jour"
else
  curl -fsS "${H[@]}" -X POST "$B/team/new" -d "$(jq -n --argjson m "$MODELS" '{team_alias: "R&D", models: $m}')" >/dev/null
  echo "• équipe R&D : créée"
fi
