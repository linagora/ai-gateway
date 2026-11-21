"""Lit les quotas de l'organisation Scaleway pour un modèle de conversation, dans les en-têtes x-ratelimit-* d'une
réponse de Scaleway (runbook, « Modèles de Scaleway ») : le tableau public des quotas omet plusieurs modèles servis. Un
seul jeton est demandé, avec l'adresse et la clé de l'environnement du conteneur LiteLLM, jamais affichées.

  cd /opt/linagora-ia && docker compose exec -T litellm python3 - <nom chez Scaleway> < scripts/lire-quotas-scaleway.py

Code de sortie : 0 si Scaleway répond 200 ; 1 pour un usage incorrect ou une autre réponse.
"""
import json
import os
import sys
import urllib.error
import urllib.request

USAGE = "usage : docker compose exec -T litellm python3 - <nom chez Scaleway> < scripts/lire-quotas-scaleway.py"

if len(sys.argv) != 2 or sys.argv[1].startswith("-"):
    raise SystemExit(USAGE)
nom = sys.argv[1]
corps = {"model": nom, "messages": [{"role": "user", "content": "ok"}], "max_tokens": 1}
req = urllib.request.Request(os.environ["SCALEWAY_API_BASE"] + "/chat/completions", method="POST", data=json.dumps(corps).encode(),
                             headers={"Authorization": f"Bearer {os.environ['SCALEWAY_API_KEY']}", "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        statut, entetes = r.status, r.headers
except urllib.error.HTTPError as e:
    raise SystemExit(f"✘ {nom} : HTTP {e.code} {e.read()[:300]!r}")
print(f"• {nom} : HTTP {statut}")
for cle, valeur in entetes.items():
    if cle.lower().startswith("x-ratelimit"):
        print(f"  {cle} : {valeur}")
