#!/usr/bin/env bash
# Données de démonstration pour le LiteLLM de dev : 5 modèles à réponses simulées (aucun appel externe),
# tarifés en euros, et une équipe « R&D » sans membre. Idempotent. Valeurs FACTICES.
#   ./dev/seed-litellm.sh
set -euo pipefail
B="${LITELLM_BASE_URL:-http://127.0.0.1:54400/admin}"
H=(-H "Authorization: Bearer ${LITELLM_MASTER_KEY:-sk-dev-master-key}" -H "Content-Type: application/json")

model() { # nom, niveau, hébergement, prix entrée, prix sortie (€ par jeton), fournisseur, éditeur, capacités, hébergeurs (JSON), zone[, contexte[, type d'API[, prix d'une image (€)[, autres faits (JSON)]]]]
  local info id autres="${14:-}"
  [[ -n "$autres" ]] || autres='{}'
  info=$(jq -n --arg l "$2" --arg h "$3" --arg f "$6" --arg e "$7" --argjson c "$8" --argjson hb "$9" --arg z "${10}" --argjson ctx "${11:-128000}" --arg t "${12:-}" --argjson pi "${13:-null}" --argjson x "$autres" \
    '{data_level: $l, hosting: $h, pricing_currency: "EUR", max_input_tokens: $ctx, fournisseur: $f, editeur: $e, capacites: $c, hebergeurs: $hb, zone: $z}
     + (if $t == "" then {} else {type_api: $t} end) + (if $pi == null then {} else {prix_image_eur: $pi} end) + $x')
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

# Faits techniques comme les déclare la passerelle de production : fournisseur, éditeur, capacités, hébergeurs, zone ;
# pour la configuration d'OpenCode, sortie maximale, efforts de raisonnement et contenus acceptés.
model dev-public N1 HORS_UE 0.0000001 0.0000004 OpenRouter "Moonshot AI" '["images","raisonnement"]' '["Fireworks"]' monde 128000 "" null \
  '{"max_output_tokens": 32768, "efforts_raisonnement": ["low", "medium", "high"], "effort_par_defaut": "medium", "contenus_entree": ["text", "image"], "contenus_sortie": ["text"]}'
model dev-interne N2 UE 0.0000002 0.0000006 OpenRouter "Mistral AI" '["images"]' '["Mistral"]' UE 128000 "" null \
  '{"max_output_tokens": 16384, "contenus_entree": ["text", "image", "pdf"], "contenus_sortie": ["text"]}'
# Comme Qwen3.8 : un modèle qui raisonne, sans efforts connus.
model dev-confidentiel N3 INTERNE 0.0000004 0.0000027 OVHcloud "Alibaba (Qwen)" '["images","raisonnement"]' '["OVHcloud"]' UE 262144 "" null \
  '{"max_output_tokens": 262144, "contenus_entree": ["text", "image"], "contenus_sortie": ["text"]}'
# Comme JEV : une API de décision (« System One »), et non un modèle de conversation.
model dev-experimental EXP HORS_UE 0.0000001 0.0000004 Typesafe Typesafe '[]' '["Typesafe"]' monde 128000 decision null \
  '{"contenus_entree": ["text"], "contenus_sortie": ["text"]}'
# Comme FLUX.2 [pro] : un modèle d'images, facturé au jeton d'image, avec un prix indicatif par image.
model dev-image N1 HORS_UE 0 0.00001 OpenRouter "Black Forest Labs" '["images","generation_images"]' '["Black Forest Labs"]' monde 46864 image 0.03 \
  '{"contenus_entree": ["text", "image"], "contenus_sortie": ["image"]}'

MODELS='["dev-public", "dev-interne", "dev-confidentiel", "dev-experimental", "dev-image"]'

TEAM_ID=$(curl -fsS "${H[@]}" "$B/team/list" | jq -r 'first(.[] | select(.team_alias == "R&D") | .team_id) // empty')
if [[ -n "$TEAM_ID" ]]; then
  curl -fsS "${H[@]}" -X POST "$B/team/update" -d "$(jq -n --arg t "$TEAM_ID" --argjson m "$MODELS" '{team_id: $t, models: $m}')" >/dev/null
  echo "• équipe R&D : déjà présente, modèles mis à jour"
else
  curl -fsS "${H[@]}" -X POST "$B/team/new" -d "$(jq -n --argjson m "$MODELS" '{team_alias: "R&D", models: $m}')" >/dev/null
  echo "• équipe R&D : créée"
fi

# Comme les équipes du groupe en production : sans liste de modèles (le portail contrôle niveau et visibilité).
if curl -fsS "${H[@]}" "$B/team/list" | jq -e 'any(.[]; .team_alias == "LPS Paris")' >/dev/null; then
  echo "• équipe LPS Paris : déjà présente"
else
  curl -fsS "${H[@]}" -X POST "$B/team/new" -d '{"team_alias": "LPS Paris"}' >/dev/null
  echo "• équipe LPS Paris : créée"
fi
