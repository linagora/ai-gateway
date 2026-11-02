"""Crée la clé de l'accès gratuit de vLLM Semantic Router (decision.vllm-sr.ai), qui sert d3-ultra, et l'écrit dans
.env (VLLM_SR_API_KEY) sans jamais l'afficher. Sur le serveur, depuis /opt/linagora-ia :

  python3 scripts/creer-cle-vllm-sr.py --accepter-les-conditions

Créer une clé vaut acceptation des conditions d'utilisation du service (https://decision.vllm-sr.ai/terms), au nom de
LINAGORA : requêtes et réponses peuvent être conservées et servir à entraîner les modèles, d'où le niveau Expérimental
(données publiques uniquement). La méthode est celle de la documentation du service (« Create a key from a terminal ») :
une preuve de travail (SHA-256) sur un défi, puis la création de la clé.

Idempotent : une clé présente et active est gardée ; une clé refusée (révoquée ou inconnue) est remplacée. Toute autre
réponse arrête le script sans créer de clé, le nombre de clés par adresse étant limité.
Ensuite : recréer LiteLLM (docker compose up -d litellm) pour qu'il lise la clé, puis déclarer le modèle
(declare-modeles-directs.py).
"""
import hashlib
import itertools
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://decision.vllm-sr.ai"
VARIABLE = "VLLM_SR_API_KEY"
MODELE = "vllm-sr/d3-ultra"
ENV = Path(__file__).resolve().parent.parent / ".env"


def appel(methode, chemin, corps=None, cle=None):
    """Statut HTTP et corps JSON (un dictionnaire vide si le corps n'est pas du JSON)."""
    entetes = {"Content-Type": "application/json"} if corps is not None else {}
    if cle:
        entetes["Authorization"] = f"Bearer {cle}"
    donnees = json.dumps(corps).encode() if corps is not None else (b"" if methode == "POST" else None)
    requete = urllib.request.Request(BASE + chemin, method=methode, data=donnees, headers=entetes)
    try:
        with urllib.request.urlopen(requete, timeout=30) as r:
            statut, brut = r.status, r.read()
    except urllib.error.HTTPError as e:
        statut, brut = e.code, e.read()
    try:
        corps_reponse = json.loads(brut or b"{}")
    except ValueError:
        corps_reponse = {}
    return statut, corps_reponse if isinstance(corps_reponse, dict) else {}


def cle_presente():
    for ligne in ENV.read_text(encoding="utf-8").splitlines():
        if ligne.startswith(f"{VARIABLE}="):
            valeur = ligne.split("=", 1)[1].strip()
            return None if valeur in ("", "__ASK__") else valeur
    return None


def ecrire(valeur):
    """Remplace ou ajoute la variable dans .env, par un fichier temporaire en 600 renommé ensuite."""
    lignes = ENV.read_text(encoding="utf-8").splitlines()
    nouvelle = f"{VARIABLE}={valeur}"
    if any(ligne.startswith(f"{VARIABLE}=") for ligne in lignes):
        lignes = [nouvelle if ligne.startswith(f"{VARIABLE}=") else ligne for ligne in lignes]
    else:
        lignes.append(nouvelle)
    descripteur, temporaire = tempfile.mkstemp(prefix=".env.", dir=ENV.parent)
    with os.fdopen(descripteur, "w", encoding="utf-8") as f:
        f.write("\n".join(lignes) + "\n")
    os.chmod(temporaire, 0o600)
    os.replace(temporaire, ENV)


def erreur(corps):
    """Code et message d'erreur du service, sans aucun autre champ de la réponse (qui pourrait porter une clé)."""
    e = corps.get("error")
    return json.dumps({k: e.get(k) for k in ("code", "message")}, ensure_ascii=False)[:300] if isinstance(e, dict) else "sans détail"


if not ENV.exists():
    sys.exit(f"✘ {ENV} introuvable : lancer le script depuis le dossier de déploiement")

existante = cle_presente()
if existante:
    statut, infos = appel("GET", "/api/keys/self", cle=existante)
    if statut == 200 and infos.get("status") == "active":
        print(f"• {VARIABLE} : clé présente et active ({infos.get('key_id')}) ; aucune clé créée")
        sys.exit(0)
    if statut != 401:
        sys.exit(f"✘ vérification de la clé présente impossible (HTTP {statut}, {erreur(infos)}) : aucune clé créée")
    print(f"• {VARIABLE} : clé présente refusée par le service ({erreur(infos)}) ; une nouvelle clé la remplace")

if "--accepter-les-conditions" not in sys.argv[1:]:
    sys.exit("✘ créer la clé vaut acceptation des conditions d'utilisation (https://decision.vllm-sr.ai/terms) au nom de "
             "LINAGORA : relancer avec --accepter-les-conditions")

statut, defi = appel("POST", "/api/keys/challenge")
try:
    texte_defi, difficulte = str(defi["challenge"]), int(defi["difficulty"])
except (KeyError, TypeError, ValueError):
    texte_defi = difficulte = None
if statut != 200 or difficulte is None:
    sys.exit(f"✘ défi refusé (HTTP {statut}, {erreur(defi)})")
cible = 1 << (256 - difficulte)
nonce = next(n for n in itertools.count()
             if int.from_bytes(hashlib.sha256(f"{texte_defi}:{n}".encode()).digest(), "big") < cible)

statut, creation = appel("POST", "/api/keys", {"challenge": texte_defi, "nonce": str(nonce), "accept_terms": True})
cle = creation.get("api_key")
if statut not in (200, 201) or not isinstance(cle, str) or not cle.startswith("sk-vsr-"):
    sys.exit(f"✘ création refusée (HTTP {statut}, {erreur(creation)}) : .env non modifié")
ecrire(cle)  # avant toute vérification : le service ne montre la clé qu'une fois

statut, infos = appel("GET", "/api/keys/self", cle=cle)
limites = ((infos.get("limits") or {}).get("models") or {}).get(MODELE)
empreinte = hashlib.sha256(cle.encode()).hexdigest()[:12]
print(f"• {VARIABLE} renseignée : empreinte SHA-256 {empreinte}, {infos.get('key_id')}, état {infos.get('status')} "
      f"(HTTP {statut}) ; limites de {MODELE} : {json.dumps(limites, ensure_ascii=False)}")
print("  Ensuite : docker compose up -d litellm, puis "
      "docker compose exec -T litellm python3 - < scripts/declare-modeles-directs.py")
