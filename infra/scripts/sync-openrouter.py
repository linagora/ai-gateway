"""Déclare dans LiteLLM les modèles de la liste blanche OpenRouter (litellm/liste-blanche-openrouter.yaml)
et vérifie qu'aucun autre modèle OpenRouter, ni aucun joker, n'y est déclaré. Idempotent.

  cd /opt/linagora-ia && docker compose exec -T litellm python3 - [--appliquer] [--seulement=nom,nom] [--supprimer-hors-liste] < scripts/sync-openrouter.py

Sans option : affiche le plan et sort en erreur s'il reste un écart. --appliquer crée ou met à jour les
modèles de la liste ; --seulement=nom,nom limite ces créations et mises à jour aux modèles nommés (les autres
écarts restent signalés) ; --supprimer-hors-liste supprime en plus les modèles OpenRouter qui n'y figurent pas.

Pour chaque modèle : points d'accès OpenRouter de sa zone (API publique /models/<id>/endpoints), prix
en € = prix le plus élevé de ces points d'accès × (1 + frais) × taux, routage limité à ces points
d'accès sans repli. Déclaration « openai/<id> » sur l'API d'OpenRouter, et non par la route
« openrouter/ » de LiteLLM : celle-ci enregistre le coût renvoyé par OpenRouter, en dollars, à la
place de nos tarifs en euros (vérifié sur la 1.102.1).
"""
import json
import os
import sys
import urllib.error
import urllib.request

import yaml

LISTE = "/app/passerelle/liste-blanche-openrouter.yaml"
PROXY = "http://localhost:4000/admin"
OPENROUTER = "https://openrouter.ai/api/v1"
SOURCE = "liste-blanche-openrouter"  # model_info.source des modèles gérés par ce script
# Éditeur d'un modèle, d'après l'auteur de son identifiant OpenRouter (à défaut, l'auteur tel quel).
EDITEURS = {"mistralai": "Mistral AI", "google": "Google", "z-ai": "Z.ai (Zhipu)", "deepseek": "DeepSeek",
            "moonshotai": "Moonshot AI", "qwen": "Alibaba (Qwen)"}

appliquer = "--appliquer" in sys.argv
supprimer = "--supprimer-hors-liste" in sys.argv
seulement = next((a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--seulement=")), None)


def agir(nom):
    """Le modèle `nom` est-il créé ou mis à jour par ce passage ?"""
    return appliquer and (seulement is None or nom in seulement)


def http(methode, url, corps=None, auth=True):
    entetes = {"Content-Type": "application/json"}
    if auth:
        entetes["Authorization"] = f"Bearer {os.environ['LITELLM_MASTER_KEY']}"
    req = urllib.request.Request(url, method=methode, headers=entetes, data=json.dumps(corps).encode() if corps is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{methode} {url} : HTTP {e.code} {e.read()[:300]!r}")


def dans_zone(tag, zone):
    return [z for z in zone if tag == z or tag.startswith(z + "/")]


def arrondi(x):
    """Six chiffres significatifs."""
    return float(f"{x:.6g}")


def declaration(entree, cfg):
    zone = cfg["zones"][entree["zone"]]
    donnees = http("GET", f"{OPENROUTER}/models/{entree['openrouter']}/endpoints", auth=False)["data"]
    tous = donnees["endpoints"]
    plafond = entree.get("prix_max_usd")
    retenus = [e for e in tous if dans_zone(e["tag"], zone) and (
        plafond is None or (float(e["pricing"]["prompt"]) * 1e6 <= plafond[0] and float(e["pricing"]["completion"]) * 1e6 <= plafond[1]))]
    if not retenus:
        raise SystemExit(f"✘ {entree['nom']} : aucun point d'accès OpenRouter dans la zone {entree['zone']} "
                         f"(disponibles : {', '.join(e['tag'] for e in tous)})")
    usd_in = max(float(e["pricing"]["prompt"]) for e in retenus)
    usd_out = max(float(e["pricing"]["completion"]) for e in retenus)
    k = (1 + cfg["frais_openrouter"]) * cfg["taux_usd_eur"]
    provider = {"only": sorted({z for e in retenus for z in dans_zone(e["tag"], zone)}), "allow_fallbacks": False}
    if entree["zone"] == "monde":
        provider["data_collection"] = "deny"
    if plafond is not None:
        provider["max_price"] = {"prompt": plafond[0], "completion": plafond[1]}
    # Capacités affichées au catalogue ; les outils et les sorties JSON, communs à tous les modèles, n'en sont pas.
    entrees = set((donnees.get("architecture") or {}).get("input_modalities") or [])
    raisonne = any({"reasoning", "include_reasoning"} & set(e.get("supported_parameters") or []) for e in retenus)
    capacites = [c for c, oui in [("images", "image" in entrees), ("audio_video", bool(entrees & {"audio", "video"})),
                                  ("raisonnement", raisonne)] if oui]
    auteur = entree["openrouter"].split("/")[0]
    return {
        "model_name": entree["nom"],
        "litellm_params": {
            "model": f"openai/{entree['openrouter']}",
            "api_base": OPENROUTER,
            "api_key": "os.environ/OPENROUTER_API_KEY",
            "input_cost_per_token": arrondi(usd_in * k),
            "output_cost_per_token": arrondi(usd_out * k),
            "provider": provider,
        },
        "model_info": {
            "source": SOURCE,
            "fournisseur": "OpenRouter",
            "editeur": EDITEURS.get(auteur, auteur),
            "capacites": capacites,
            "hebergeurs": sorted({e["provider_name"] for e in retenus}),
            "openrouter_model": entree["openrouter"],
            "data_level": entree.get("niveau", "N1"),
            "hosting": "UE" if entree["zone"] == "UE" else "HORS_UE",
            "zone": entree["zone"],
            "points_acces": sorted(e["tag"] for e in retenus),
            "pricing_currency": "EUR",
            "fx_rate_usd_eur": cfg["taux_usd_eur"],
            "frais_openrouter": cfg["frais_openrouter"],
            "prix_usd_par_mtoken": [arrondi(usd_in * 1e6), arrondi(usd_out * 1e6)],
            "max_input_tokens": min(e["context_length"] for e in retenus),
        },
    }


def ecarts(voulu, existant):
    """Champs déclarés par ce script qui diffèrent de la déclaration existante (la clé d'API est ignorée)."""
    lp, mi = existant.get("litellm_params") or {}, existant.get("model_info") or {}
    diff = [f"litellm_params.{k}" for k, v in voulu["litellm_params"].items() if k != "api_key" and lp.get(k) != v]
    return diff + [f"model_info.{k}" for k, v in voulu["model_info"].items() if mi.get(k) != v]


def est_openrouter(m):
    lp = m.get("litellm_params") or {}
    return "openrouter" in str(lp.get("model", "")) or "openrouter.ai" in str(lp.get("api_base", "")) or (m.get("model_info") or {}).get("source") == SOURCE


cfg = yaml.safe_load(open(LISTE))
voulus = {e["nom"]: declaration(e, cfg) for e in cfg["modeles"]}
deja = {}
for m in http("GET", f"{PROXY}/model/info")["data"]:
    deja.setdefault(m["model_name"], []).append(m)

reste = 0
for nom, v in voulus.items():
    eur = [v["litellm_params"]["input_cost_per_token"] * 1e6, v["litellm_params"]["output_cost_per_token"] * 1e6]
    resume = f"{v['model_info']['zone']} via {', '.join(v['litellm_params']['provider']['only'])} ; {eur[0]:.4f} € / {eur[1]:.4f} € par Mtoken"
    existants = deja.get(nom, [])
    if len(existants) > 1:
        print(f"✘ {nom} : déclaré {len(existants)} fois, à corriger à la main")
        reste += 1
    elif not existants:
        print(f"+ {nom} : {'créé' if agir(nom) else 'à créer'} ({resume})")
        if agir(nom):
            http("POST", f"{PROXY}/model/new", v)
        else:
            reste += 1
    elif d := ecarts(v, existants[0]):
        print(f"~ {nom} : {'mis à jour' if agir(nom) else 'à mettre à jour'} ({', '.join(d)}) ({resume})")
        if agir(nom):
            http("PATCH", f"{PROXY}/model/{existants[0]['model_info']['id']}/update", v)
        else:
            reste += 1
    else:
        print(f"= {nom} : conforme ({resume})")

for nom, liste in deja.items():
    for m in liste:
        lp = m.get("litellm_params") or {}
        if "*" in nom or "*" in str(lp.get("model", "")):
            print(f"✘ {nom} : joker interdit ({lp.get('model')})")
            reste += 1
        elif est_openrouter(m) and nom not in voulus:
            print(f"✘ {nom} : modèle OpenRouter hors liste blanche ({lp.get('model')})")
            if supprimer:
                http("POST", f"{PROXY}/model/delete", {"id": m["model_info"]["id"]})
                print("  supprimé")
            else:
                reste += 1

print(f"\n{len(voulus)} modèles dans la liste blanche ; {'écarts restants : ' + str(reste) if reste else 'aucun écart'}")
sys.exit(1 if reste else 0)
