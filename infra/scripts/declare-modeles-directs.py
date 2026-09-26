"""Déclare dans LiteLLM les modèles joints sans OpenRouter : Qwen3.8 (OVHcloud, N3) et JEV (Typesafe,
niveau Expérimental). Idempotent : un modèle absent est déclaré ; un modèle présent reçoit les
informations ci-dessous (toutes, pour ne rien réécrire de ce que LiteLLM dérive lui-même) et sa
route (litellm_params.model) ; son adresse, sa clé et ses tarifs restent inchangés.

  cd /opt/linagora-ia && docker compose exec -T litellm python3 - < scripts/declare-modeles-directs.py

JEV passe par le fournisseur personnalisé « typesafe » (litellm/jev.py) : clés, budgets et coûts
comme pour tout modèle, coût calculé sur les jetons comptés par Typesafe.
"""
import json
import os
import urllib.request

PROXY = "http://localhost:4000/admin"
TAUX_USD_EUR = 0.87974  # BCE, 2026-09-24 (même taux que la liste blanche OpenRouter)

MODELES = [
    {
        "model_name": "qwen3.8",
        "litellm_params": {
            # Fournisseur OVHcloud de LiteLLM, et non « openai/… » : avec cette route, LiteLLM traduit /v1/messages
            # (format Anthropic, celui de Claude Code) vers l'API Responses et y ajoute
            # include: ["reasoning.encrypted_content"], que le serveur d'OVH refuse (2026-09-26).
            "model": "ovhcloud/Qwen3.8-27B",
            "api_base": "os.environ/OVH_QWEN_API_BASE",
            "api_key": "os.environ/OVH_QWEN_API_KEY",
            "input_cost_per_token": 0.0000004,  # 0,40 € HT par million de jetons (tarif public OVH, validé le 2026-09-24)
            "output_cost_per_token": 0.0000027,  # 2,70 € HT
        },
        "model_info": {
            "source": "ovhcloud",
            "fournisseur": "OVHcloud",
            "editeur": "Alibaba (Qwen)",
            "capacites": ["images", "raisonnement"],  # vérifié par appel le 2026-09-25
            "hebergeurs": ["OVHcloud"],
            "zone": "UE",
            "data_level": "N3",
            "hosting": "INTERNE_OVH",
            "pricing_currency": "EUR",
            "pricing_source": "Tarif public OVH AI Endpoints : 0,40 € / 2,70 € HT par million de jetons (entrée / sortie), validé par Linagora le 2026-09-24",
            "max_input_tokens": 262144,
            "max_output_tokens": 262144,
        },
    },
    {
        "model_name": "jev-latest",
        "litellm_params": {
            "model": "typesafe/jev-latest",
            "api_base": "https://api.typesafe.ai/v1",
            "api_key": "os.environ/TYPESAFE_API_KEY",
            "input_cost_per_token": float(f"{0.042e-6 * TAUX_USD_EUR:.6g}"),  # 0,042 $ par million de jetons d'entrée
            "output_cost_per_token": 0.0,  # sortie gratuite
        },
        "model_info": {
            "source": "typesafe",
            "fournisseur": "Typesafe",
            "editeur": "Typesafe",
            "capacites": [],
            "hebergeurs": ["Typesafe"],
            "zone": "monde",
            "data_level": "EXP",
            "hosting": "HORS_UE",
            "pricing_currency": "EUR",
            "fx_rate_usd_eur": TAUX_USD_EUR,
            "type_api": "decision",  # lu par le portail : JEV n'est pas un modèle de conversation
            "usage": "API System One : requête JSON {state, questions} dans le dernier message (jev.py)",
        },
    },
]


def http(methode, chemin, corps=None):
    req = urllib.request.Request(PROXY + chemin, method=methode, data=json.dumps(corps).encode() if corps is not None else None,
                                 headers={"Authorization": f"Bearer {os.environ['LITELLM_MASTER_KEY']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


existants = {m["model_name"]: m for m in http("GET", "/model/info")["data"]}
for modele in MODELES:
    nom = modele["model_name"]
    if nom in existants:
        # PATCH : LiteLLM fusionne ; seule la route change parmi les paramètres d'appel.
        route = modele["litellm_params"]["model"]
        http("PATCH", f"/model/{existants[nom]['model_info']['id']}/update", {"model_info": modele["model_info"], "litellm_params": {"model": route}})
        print(f"• {nom} : informations complétées, route {route}")
    else:
        http("POST", "/model/new", modele)
        print(f"• {nom} : déclaré")
