"""Déclare dans LiteLLM les modèles hors de la liste blanche OpenRouter : Qwen3.8 et trois modèles d'embeddings
(OVHcloud, N3, ticket #125), et JEV (Typesafe, niveau Expérimental, par l'API System One d'OpenRouter, ticket #104).
Idempotent : un modèle absent est déclaré ; un modèle présent reçoit les informations ci-dessous (toutes, pour ne
rien réécrire de ce que LiteLLM dérive lui-même), sa route, son adresse et sa clé (des références à l'environnement) ;
ses tarifs restent inchangés.

  cd /opt/linagora-ia && docker compose exec -T litellm python3 - < scripts/declare-modeles-directs.py

JEV passe par le fournisseur personnalisé « typesafe » (litellm/jev.py), qui appelle l'API System One
d'OpenRouter avec la clé OpenRouter : clés, budgets et coûts comme pour tout modèle, coût calculé sur
les jetons comptés par Typesafe.
"""
import json
import os
import urllib.request

PROXY = "http://localhost:4000/admin"
TAUX_USD_EUR = 0.87974  # BCE, 2026-09-24 (même taux que la liste blanche OpenRouter)


def modele_embeddings(nom, nom_ovh, editeur, prix_eur_par_million, contexte, taille):
    """Modèle d'embeddings d'OVH AI Endpoints, joint avec l'adresse et la clé de Qwen3.8, facturé à l'entrée seule."""
    prix = f"{prix_eur_par_million:.2f}".replace(".", ",")
    return {
        "model_name": nom,
        "litellm_params": {
            # Route compatible OpenAI de vLLM : dans LiteLLM 1.102.1, la seule qui transmet encoding_format (envoyé par
            # défaut par les SDK OpenAI, en base64) et dimensions. Le fournisseur ovhcloud de LiteLLM refuse tout
            # paramètre des embeddings ; la route openai/ refuse dimensions (vérifié le 2026-10-04, spécification #123).
            "model": f"hosted_vllm/{nom_ovh}",
            "api_base": "os.environ/OVH_QWEN_API_BASE",
            "api_key": "os.environ/OVH_QWEN_API_KEY",
            "input_cost_per_token": float(f"{prix_eur_par_million / 1e6:.6g}"),
            "output_cost_per_token": 0.0,  # un modèle d'embeddings ne produit pas de jetons de sortie
        },
        "model_info": {
            "source": "ovhcloud",
            "fournisseur": "OVHcloud",
            "editeur": editeur,
            "capacites": [],
            "hebergeurs": ["OVHcloud"],
            "zone": "UE",
            "data_level": "N3",
            "hosting": "INTERNE_OVH",
            "pricing_currency": "EUR",
            "fx_rate_usd_eur": TAUX_USD_EUR,
            "pricing_source": f"Tarif public OVH AI Endpoints : {prix} € HT par million de jetons d'entrée, retenu par Linagora le 2026-10-04",
            "max_input_tokens": contexte,  # publié par OVH (/v1/models, context_length)
            "type_api": "embeddings",  # lu par le portail : appelé par /v1/embeddings, et non par la conversation
            "output_vector_size": taille,  # champ standard de LiteLLM pour la taille des vecteurs, lu par le portail
            "mode": "embedding",  # pour que les contrôles de santé de LiteLLM l'interrogent par /embeddings
        },
    }


MODELES = [
    {
        "model_name": "qwen3.8",
        "litellm_params": {
            # Fournisseur OVHcloud de LiteLLM, et non « openai/… » : avec cette route, LiteLLM traduit /v1/messages
            # (format Anthropic, utilisé par des assistants de code) vers l'API Responses et y ajoute
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
            # Taux interne, comme pour les autres modèles : le portail convertit le prix en dollars pour OpenCode.
            "fx_rate_usd_eur": TAUX_USD_EUR,
            "pricing_source": "Tarif public OVH AI Endpoints : 0,40 € / 2,70 € HT par million de jetons (entrée / sortie), validé par Linagora le 2026-09-24",
            "max_input_tokens": 262144,
            "max_output_tokens": 262144,
            # Contenus acceptés et produits, lus par le portail pour la configuration d'OpenCode.
            "contenus_entree": ["text", "image"],
            "contenus_sortie": ["text"],
        },
    },
    {
        "model_name": "jev-latest",
        "litellm_params": {
            # Alias de la dernière version de JEV chez OpenRouter (typesafe/jev-1.13 le 2026-09-30).
            "model": "typesafe/~typesafe/jev-latest",
            "api_base": "https://openrouter.ai/api/v1",
            "api_key": "os.environ/OPENROUTER_API_KEY",
            "input_cost_per_token": float(f"{0.042e-6 * TAUX_USD_EUR:.6g}"),  # 0,042 $ par million de jetons d'entrée
            "output_cost_per_token": 0.0,  # sortie gratuite
        },
        "model_info": {
            "source": "openrouter-system-one",
            "fournisseur": "OpenRouter",
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
            "contenus_entree": ["text"],
            "contenus_sortie": ["text"],
        },
    },
    modele_embeddings("bge-m3", "bge-m3", "BAAI", 0.01, 8192, 1024),
    modele_embeddings("bge-multilingual-gemma2", "bge-multilingual-gemma2", "BAAI", 0.01, 8192, 3584),
    modele_embeddings("qwen3-embedding-8b", "Qwen3-Embedding-8B", "Alibaba (Qwen)", 0.10, 32768, 4096),
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
        # PATCH : LiteLLM fusionne ; parmi les paramètres d'appel, la route, l'adresse et la clé changent, pas les tarifs.
        acces = {k: modele["litellm_params"][k] for k in ("model", "api_base", "api_key")}
        http("PATCH", f"/model/{existants[nom]['model_info']['id']}/update", {"model_info": modele["model_info"], "litellm_params": acces})
        print(f"• {nom} : informations complétées, route {acces['model']}")
    else:
        http("POST", "/model/new", modele)
        print(f"• {nom} : déclaré")
