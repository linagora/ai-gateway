"""Supprime de LiteLLM un modèle sorti de la déclaration de declare-modeles-directs.py : fin de service d'un modèle de
Scaleway, ou du double -scaleway d'un modèle dont la version de Scaleway a repris le nom (runbook, « Modèles de
Scaleway »). Sans --supprimer, le script montre seulement ce qu'il supprimerait. La suppression se fait après
confirmation, une fois la fiche du modèle masquée dans le portail (Gestion › Catalogue), qui ne montre plus la fiche d'un
modèle absent de LiteLLM.

  cd /opt/linagora-ia && docker compose exec -T litellm python3 - <nom> [--supprimer] < scripts/supprimer-modele-direct.py

Un modèle de la liste blanche OpenRouter se supprime par sync-openrouter.py (--supprimer-hors-liste), une fois retiré de
la liste : ce script le refuse.

Code de sortie : 0 quand le script liste ou supprime le modèle ; 1 pour un usage incorrect, un modèle absent de LiteLLM
(déjà supprimé, par exemple : rejouer ne change rien) ou de la liste blanche OpenRouter, ou une erreur de l'API.
"""
import json
import os
import sys
import urllib.error
import urllib.request

PROXY = "http://localhost:4000/admin"
USAGE = "usage : docker compose exec -T litellm python3 - <nom> [--supprimer] < scripts/supprimer-modele-direct.py"


def echec(message):
    """Tout passe par la sortie standard : docker compose exec transmet stdout et stderr par deux flux, dont l'ordre
    d'arrivée varie, et un refus écrit sur stderr paraîtrait parfois avant la liste qui le précède."""
    print(message)
    sys.exit(1)


def http(methode, chemin, corps=None):
    req = urllib.request.Request(PROXY + chemin, method=methode, data=json.dumps(corps).encode() if corps is not None else None,
                                 headers={"Authorization": f"Bearer {os.environ['LITELLM_MASTER_KEY']}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        echec(f"✘ {methode} {chemin} : HTTP {e.code} {e.read()[:300]!r}")


def deploiements(nom):
    return [m for m in http("GET", "/model/info")["data"] if m["model_name"] == nom]


def est_openrouter(m):
    """Règle de sync-openrouter.py, recopiée faute d'import possible (scripts lus sur l'entrée standard). JEV, qui passe
    par l'API System One d'OpenRouter, est une déclaration directe."""
    lp = m.get("litellm_params") or {}
    if str(lp.get("model", "")).startswith("typesafe/"):
        return False
    return "openrouter" in str(lp.get("model", "")) or "openrouter.ai" in str(lp.get("api_base", "")) \
        or (m.get("model_info") or {}).get("source") == "liste-blanche-openrouter"


noms = [a for a in sys.argv[1:] if not a.startswith("--")]
options = {a for a in sys.argv[1:] if a.startswith("--")}
if len(noms) != 1 or not options <= {"--supprimer"}:
    echec(USAGE)
nom = noms[0]
trouves = deploiements(nom)
if not trouves:
    echec(f"✘ {nom} : absent de LiteLLM (nom à vérifier, ou modèle déjà supprimé)")
for m in trouves:
    lp, mi = m.get("litellm_params") or {}, m.get("model_info") or {}
    print(f"• {nom} : route {lp.get('model')}, source {mi.get('source')}, niveau {mi.get('data_level')}, id {mi.get('id')}")
if any(est_openrouter(m) for m in trouves):
    echec(f"✘ {nom} : modèle de la liste blanche OpenRouter ; le retirer de la liste, puis sync-openrouter.py "
          "--supprimer-hors-liste")
if "--supprimer" not in options:
    print("Rien n'est supprimé. Après confirmation, la fiche masquée : même commande avec --supprimer.")
    sys.exit(0)
for m in trouves:
    http("POST", "/model/delete", {"id": m["model_info"]["id"]})
if deploiements(nom):
    echec(f"✘ {nom} : encore dans /model/info après la suppression")
# En production, LiteLLM tourne en deux processus (--num_workers 2). /model/info ne montre plus le modèle, mais le
# processus qui n'a pas reçu la suppression le sert encore jusqu'à sa relecture de la base, toutes les 30 s (1.102.1,
# vérifié le 2026-11-21).
print(f"✔ {nom} : supprimé de LiteLLM ; servi encore 30 s au plus par le second processus")
