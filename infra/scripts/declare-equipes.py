"""Déclare dans LiteLLM les équipes du groupe Linagora, que les salariés peuvent demander à
rejoindre depuis le portail. Idempotent : une équipe existante (même alias) est laissée telle quelle.

  cd /opt/linagora-ia && docker compose exec -T litellm python3 - < scripts/declare-equipes.py

Les équipes sont créées sans liste de modèles ni budget : sans liste, LiteLLM leur ouvre tous les modèles,
et le portail contrôle toujours le niveau de confidentialité et la visibilité des modèles de chaque clé.
Les budgets restent ceux des clés, fixés par les admins à l'approbation.
"""
import json
import os
import urllib.request

PROXY = "http://localhost:4000/admin"
EQUIPES = [
    "LGS Software",
    "LGS Research",
    "LRS OSSA",
    "LRS IT Services",
    "LPS Paris",
    "LPS GSO",
    "LINAGORA Tunisia",
    "LINAGORA Vietnam",
    "Direction Générale",
    "Equipe Commerciale",
    "Equipes Administrative/Marketing/Support",
]


def http(methode, chemin, corps=None):
    req = urllib.request.Request(PROXY + chemin, method=methode, data=json.dumps(corps).encode() if corps is not None else None,
                                 headers={"Authorization": f"Bearer {os.environ['LITELLM_MASTER_KEY']}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


existantes = {e.get("team_alias") for e in http("GET", "/team/list")}
for alias in EQUIPES:
    if alias in existantes:
        print(f"= {alias} : déjà présente")
    else:
        http("POST", "/team/new", {"team_alias": alias})
        print(f"+ {alias} : créée")

finales = [e.get("team_alias") for e in http("GET", "/team/list")]
manquantes = [a for a in EQUIPES if a not in finales]
doublons = sorted({a for a in finales if finales.count(a) > 1})
print(f"\n{len(finales)} équipe(s) dans LiteLLM ; manquantes : {manquantes or 'aucune'} ; alias en double : {doublons or 'aucun'}")
raise SystemExit(1 if manquantes or doublons else 0)
