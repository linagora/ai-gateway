"""Déclare dans LiteLLM le modèle « jev-latest » (JEV de Typesafe, niveau Expérimental). Idempotent.

  cd /opt/linagora-ia && docker compose exec -T litellm python3 - < scripts/declare-jev.py

JEV passe par le fournisseur personnalisé « typesafe » (litellm/jev.py) : clés, budgets et coûts
comme pour tout modèle, coût calculé sur les jetons comptés par Typesafe.
"""
import json
import os
import urllib.request

PROXY = "http://localhost:4000/admin"
TAUX_USD_EUR = 0.87974  # BCE, 2026-09-24 (même taux que la liste blanche OpenRouter)

declaration = {
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
        "data_level": "EXP",
        "hosting": "HORS_UE",
        "pricing_currency": "EUR",
        "fx_rate_usd_eur": TAUX_USD_EUR,
        "usage": "API System One : requête JSON {state, questions} dans le dernier message (jev.py)",
    },
}


def http(methode, chemin, corps=None):
    req = urllib.request.Request(PROXY + chemin, method=methode, data=json.dumps(corps).encode() if corps is not None else None,
                                 headers={"Authorization": f"Bearer {os.environ['LITELLM_MASTER_KEY']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


existants = [m for m in http("GET", "/model/info")["data"] if m["model_name"] == declaration["model_name"]]
if existants:
    http("PATCH", f"/model/{existants[0]['model_info']['id']}/update", declaration)
    print("• jev-latest : déclaration mise à jour")
else:
    http("POST", "/model/new", declaration)
    print("• jev-latest : déclaré")
