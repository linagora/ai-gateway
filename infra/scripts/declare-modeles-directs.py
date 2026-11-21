"""Déclare dans LiteLLM les modèles hors de la liste blanche OpenRouter : Qwen3.8 et trois modèles d'embeddings
(OVHcloud, N3, ticket #125), JEV (Typesafe, niveau Expérimental, par l'API System One d'OpenRouter, ticket #104),
Nox-4B (N3, même API que JEV, sur une carte GPU de LINAGORA), d3-ultra (vLLM Semantic Router, niveau Expérimental,
même API que JEV, par l'accès gratuit de decision.vllm-sr.ai) et les modèles de Scaleway (niveau Expérimental pendant
l'essai, spécification #204).
Idempotent : un modèle absent est déclaré ; un modèle présent reçoit les informations ci-dessous (toutes, pour ne
rien réécrire de ce que LiteLLM dérive lui-même), sa route, son adresse et sa clé (des références à l'environnement),
et les paramètres qu'il écarte ; ses tarifs restent inchangés.

  cd /opt/linagora-ia && docker compose exec -T litellm python3 - < scripts/declare-modeles-directs.py

JEV passe par le fournisseur personnalisé « typesafe » (litellm/jev.py), qui appelle l'API System One
d'OpenRouter avec la clé OpenRouter : clés, budgets et coûts comme pour tout modèle, coût calculé sur
les jetons comptés par Typesafe.

Nox-4B (Decision 2.0, vLLM Semantic Router) est servi par le LiteLLM de la carte GPU sous le nom jev-latest, avec
l'API de JEV en surface OpenAI : une route openai/ suffit, sans fournisseur personnalisé. Son adresse et sa clé, qui
n'ouvre que ce modèle, sont dans .env (NOX_API_BASE, NOX_API_KEY).

d3-ultra (Decision 3.0, 27B) passe par le même fournisseur personnalisé que JEV, sous le nom « vllm-sr », vers l'API
System One de decision.vllm-sr.ai. Sa clé (VLLM_SR_API_KEY dans .env) est créée sur le serveur par
creer-cle-vllm-sr.py, qui accepte les conditions d'utilisation du service.

Les modèles de Scaleway Generative APIs sont appelés dans le projet dédié à la passerelle : son adresse et la clé de son
application IAM, limitée aux Generative APIs de ce projet, sont dans .env (SCALEWAY_API_BASE, SCALEWAY_API_KEY).
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


# Paramètres d'échantillonnage hors OpenAI : la route scaleway/ de LiteLLM 1.102.1 les passe tels quels au client OpenAI,
# qui les refuse (erreur 500 « unexpected keyword argument », vérifié le 2026-11-21 pour top_k, repetition_penalty et
# top_a ; top_k passe pourtant chez Scaleway). Écartés pour tous les modèles de Scaleway.
PARAMETRES_HORS_OPENAI_SCALEWAY = ["top_k", "min_p", "repetition_penalty", "top_a"]
# Paramètre que refusent les modèles servis avec décodage spéculatif : « The min_p and logit_bias sampling parameters are
# not yet supported with speculative decoding » (min_p, refusé au-delà de 0, est écarté pour toute la famille).
PARAMETRES_REFUSES_DECODAGE_SPECULATIF = ["logit_bias"]
RELEVE_PRIX_SCALEWAY = "2026-11-21"  # date du relevé des prix publics de Scaleway
ORDRE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]  # du plus faible au plus fort, comme sync-openrouter.py
# Faits communs aux modèles de Scaleway, appelés dans le projet dédié à la passerelle, au niveau Expérimental pendant l'essai.
ACCES_SCALEWAY = {"api_base": "os.environ/SCALEWAY_API_BASE", "api_key": "os.environ/SCALEWAY_API_KEY"}
FAITS_SCALEWAY = {"source": "scaleway", "fournisseur": "Scaleway", "hebergeurs": ["Scaleway"], "zone": "UE", "data_level": "EXP",
                  "hosting": "SCALEWAY", "pricing_currency": "EUR", "fx_rate_usd_eur": TAUX_USD_EUR}


def montant(prix):
    """Prix en euros, écrit à la française (0,60)."""
    return f"{prix:.2f}".replace(".", ",")


def par_jeton(prix):
    """Prix par jeton, d'après un prix par million de jetons."""
    return float(f"{prix / 1e6:.6g}")


def modele_conversation_scaleway(nom, nom_scaleway, editeur, *, prix_entree, prix_sortie, contexte, sortie_max, capacites,
                                 prix_cache=None, appel_outils=True, efforts_raisonnement=(), effort_par_defaut=None,
                                 systeme_en_tete=False, parametres_ecartes=()):
    """Modèle de conversation de Scaleway, au niveau Expérimental pendant l'essai. Prix en € HT par million de jetons
    (entrée, sortie, et jetons lus en cache quand Scaleway leur publie un prix), relevés le RELEVE_PRIX_SCALEWAY ; contexte
    et sortie maximale en jetons ; texte accepté en entrée, images et vidéos si les capacités en comptent. Les autres faits
    viennent des appels directs : appel d'outils, efforts de raisonnement (dans l'ordre d'ORDRE_EFFORTS), message système
    accepté seulement en tête, paramètres refusés."""
    efforts = list(efforts_raisonnement)
    if (efforts and "raisonnement" not in capacites) or not set(efforts) <= set(ORDRE_EFFORTS) \
            or efforts != sorted(efforts, key=ORDRE_EFFORTS.index) or effort_par_defaut not in (None, *efforts):
        raise SystemExit(f"✘ {nom} : efforts de raisonnement à déclarer pour un modèle qui raisonne, dans l'ordre "
                         f"{ORDRE_EFFORTS}, avec l'effort par défaut parmi eux")
    if prix_cache is None:
        # Jetons lus en cache sans prix publié : au prix d'entrée, comme pour la liste blanche OpenRouter. Sans prix
        # déclaré, LiteLLM les compte à 0 € (ticket #112).
        prix_cache, mention_cache = prix_entree, ""
    else:
        mention_cache = f", {montant(prix_cache)} € pour les jetons lus en cache"
    return {
        "model_name": nom,
        "litellm_params": {
            # Fournisseur scaleway de LiteLLM : avec lui, la 1.102.1 fait passer /v1/messages (format Anthropic, utilisé par
            # des assistants de code) par les chat completions ; avec « openai/… », par l'API Responses (spécification #204).
            "model": f"scaleway/{nom_scaleway}",
            **ACCES_SCALEWAY,
            "additional_drop_params": PARAMETRES_HORS_OPENAI_SCALEWAY + list(parametres_ecartes),
            "input_cost_per_token": par_jeton(prix_entree),
            "output_cost_per_token": par_jeton(prix_sortie),
            "cache_read_input_token_cost": par_jeton(prix_cache),
        },
        "model_info": {
            **FAITS_SCALEWAY,
            "editeur": editeur,
            "capacites": capacites,
            "pricing_source": f"Tarif public de Scaleway Generative APIs : {montant(prix_entree)} € / {montant(prix_sortie)} € HT "
                              f"par million de jetons (entrée / sortie){mention_cache}, relevé le {RELEVE_PRIX_SCALEWAY}",
            "max_input_tokens": contexte,
            "max_output_tokens": sortie_max,
            # Contenus acceptés et produits, lus par le portail pour la configuration d'OpenCode. Parmi les modèles de
            # conversation de Scaleway, la capacité audio_video ne vaut que pour des vidéos : aucun n'y prend l'audio.
            "contenus_entree": ["text", *(["image"] if "images" in capacites else []), *(["video"] if "audio_video" in capacites else [])],
            "contenus_sortie": ["text"],
            # Appel d'outils, lu par le portail : les assistants de code écartent un modèle qui n'en appelle pas. Message
            # système accepté seulement en tête de la conversation, lu par la garde (litellm/garde.py) : elle rattache ceux
            # qu'envoie Claude Code au message de l'utilisateur qui les précède. Déclarés vrais ou faux, comme l'appel
            # d'outils dans la liste blanche OpenRouter : la mise à jour d'un modèle complète sa déclaration sans en retirer
            # de champ.
            "appel_outils": appel_outils,
            "systeme_en_tete": systeme_en_tete,
            # Efforts de raisonnement, lus par le portail : les variantes d'effort du modèle dans OpenCode. Déclarés pour un
            # modèle qui en publie, comme dans la liste blanche OpenRouter.
            **({"efforts_raisonnement": efforts} if efforts else {}),
            **({"effort_par_defaut": effort_par_defaut} if effort_par_defaut else {}),
            # Champs de LiteLLM : son fournisseur scaleway retire les outils (tools, tool_choice…) de la requête d'un modèle
            # qui ne déclare pas les appeler, et n'y laisse reasoning_effort que pour un modèle qui déclare raisonner (1.102.1 ;
            # vérifié le 2026-11-21 : sans ces champs, une requête de Claude Code arrivait chez Scaleway sans ses outils).
            "supports_function_calling": appel_outils,
            "supports_reasoning": "raisonnement" in capacites,
        },
    }


def modele_embeddings_scaleway(nom, nom_scaleway, editeur, *, prix_entree, contexte, taille):
    """Modèle d'embeddings de Scaleway, au niveau Expérimental pendant l'essai, facturé à l'entrée seule. Prix en € HT par
    million de jetons d'entrée, relevé le RELEVE_PRIX_SCALEWAY ; contexte en jetons par texte ; taille des vecteurs."""
    return {
        "model_name": nom,
        "litellm_params": {
            # Route compatible OpenAI de vLLM, comme pour les embeddings d'OVH : la route scaleway/ de LiteLLM 1.102.1
            # ne fait pas d'embeddings (« Unmapped LLM provider »). Scaleway rend le format demandé, base64 des SDK
            # OpenAI compris : aucun format n'est imposé, et la garde n'a rien à convertir (vérifié le 2026-11-21).
            "model": f"hosted_vllm/{nom_scaleway}",
            **ACCES_SCALEWAY,
            "input_cost_per_token": par_jeton(prix_entree),
            "output_cost_per_token": 0.0,  # un modèle d'embeddings ne produit pas de jetons de sortie
        },
        "model_info": {
            **FAITS_SCALEWAY,
            "editeur": editeur,
            "capacites": [],
            "pricing_source": f"Tarif public de Scaleway Generative APIs : {montant(prix_entree)} € HT par million de jetons "
                              f"d'entrée, relevé le {RELEVE_PRIX_SCALEWAY}",
            "max_input_tokens": contexte,
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
            # Claude Code met son identifiant de session dans metadata.user_id ; LiteLLM en tire prompt_cache_key (1.102.1),
            # que le serveur d'OVH refuse : « feature 'prompt_cache_key' is not currently supported » (ticket #159).
            "additional_drop_params": ["prompt_cache_key"],
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
            # Le gabarit de Qwen n'accepte de message système qu'en tête : la garde (litellm/garde.py) rattache ceux du
            # milieu de la conversation, qu'envoie Claude Code, au message de l'utilisateur qui les précède (ticket #159).
            "systeme_en_tete": True,
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
    {
        "model_name": "nox-4b",
        "litellm_params": {
            # Nom du modèle chez le LiteLLM de la carte GPU, qui le sert avec l'API de JEV ; mêmes réponses que JEV en
            # forme, mais celles de Nox-4B, calibré autrement.
            "model": "openai/jev-latest",
            "api_base": "os.environ/NOX_API_BASE",
            "api_key": "os.environ/NOX_API_KEY",
            # 0 € : le modèle tourne sur une carte GPU de LINAGORA, sans coût à l'usage (décision de l'utilisateur du 2026-10-04).
            "input_cost_per_token": 0.0,
            "output_cost_per_token": 0.0,
        },
        "model_info": {
            "source": "gpu-linagora",
            "fournisseur": "LINAGORA",
            "editeur": "vLLM Semantic Router",
            "capacites": [],
            "hebergeurs": ["LINAGORA"],
            "zone": "UE",
            "data_level": "N3",
            "hosting": "INTERNE",
            "pricing_currency": "EUR",
            "fx_rate_usd_eur": TAUX_USD_EUR,
            "pricing_source": "0 € : modèle exécuté sur une carte GPU de LINAGORA, sans coût à l'usage, retenu par LINAGORA le 2026-10-04",
            # Situation, questions et critères compris ; au-delà, chaque question est refusée (max_length_exceeded), sans troncature.
            "max_input_tokens": 16384,
            "type_api": "decision",
            "usage": "API System One : requête JSON {state, questions} dans le dernier message, comme JEV",
            "contenus_entree": ["text"],
            "contenus_sortie": ["text"],
        },
    },
    {
        "model_name": "d3-ultra",
        "litellm_params": {
            # Fournisseur personnalisé « vllm-sr » (jev.py), qui transmet « vllm-sr/d3-ultra » au service : le plus
            # performant de Decision 3.0 que sert l'accès gratuit, qui répond aussi aux alias vllm-sr/d3 et vllm-sr/d3-turbo.
            "model": "vllm-sr/vllm-sr/d3-ultra",
            "api_base": "https://decision.vllm-sr.ai/v1",
            "api_key": "os.environ/VLLM_SR_API_KEY",
            # 0 € : accès gratuit de vLLM Semantic Router (décision de l'utilisateur du 2026-11-02).
            "input_cost_per_token": 0.0,
            "output_cost_per_token": 0.0,
        },
        "model_info": {
            "source": "vllm-sr-decision",
            "fournisseur": "vLLM Semantic Router",
            "editeur": "vLLM Semantic Router",
            "capacites": [],
            "hebergeurs": ["vLLM Semantic Router"],
            # Lieu d'exécution non publié ; requêtes et réponses conservées et réutilisables pour entraîner les modèles :
            # données publiques uniquement (niveau Expérimental).
            "zone": "monde",
            "data_level": "EXP",
            "hosting": "HORS_UE",
            "pricing_currency": "EUR",
            "fx_rate_usd_eur": TAUX_USD_EUR,
            "pricing_source": "0 € : accès gratuit de vLLM Semantic Router (decision.vllm-sr.ai), retenu par LINAGORA le 2026-11-02",
            # Pas de max_input_tokens : le service borne une estimation en octets (131 072 par requête, la situation
            # comptée une fois) et 131 072 caractères de situation, et non un nombre de jetons.
            "type_api": "decision",
            "usage": "API System One : requête JSON {state, questions} dans le dernier message, comme JEV",
            "contenus_entree": ["text"],
            "contenus_sortie": ["text"],
        },
    },
    modele_embeddings("bge-m3", "bge-m3", "BAAI", 0.01, 8192, 1024),
    modele_embeddings("bge-multilingual-gemma2", "bge-multilingual-gemma2", "BAAI", 0.01, 8192, 3584),
    modele_embeddings("qwen3-embedding-8b", "Qwen3-Embedding-8B", "Alibaba (Qwen)", 0.10, 32768, 4096),
    # --- Scaleway (appels directs du 2026-11-21, tickets #206, #207 et #208) ---
    # Contexte : d'après le refus d'une entrée plus longue ; sortie maximale : « max_completion_tokens is limited to … » ;
    # efforts : ceux que publie Scaleway (« Supported reasoning efforts »), l'effort par défaut quand une requête sans effort
    # se comporte comme l'un d'eux. Les modèles de conversation appellent tous des outils (tool_choice auto, required et
    # nommé, résultat renvoyé, flux). Les paramètres que la documentation dit non pris en charge (frequency_penalty, n,
    # top_logprobs, user) passent, comme prompt_cache_key.
    modele_conversation_scaleway(
        "qwen3.8-scaleway", "qwen3.8-27b", "Alibaba (Qwen)", prix_entree=0.60, prix_sortie=3.30, prix_cache=0.12,
        # Contexte de 262 144 jetons (« 256k » publiés).
        contexte=262144, sortie_max=32768, capacites=["images", "raisonnement"],
        # minimal et high passent aussi, avec les jetons d'entrée de low et de xhigh. Une requête sans effort compte ceux
        # de medium.
        efforts_raisonnement=["none", "low", "medium", "xhigh"], effort_par_defaut="medium",
        parametres_ecartes=PARAMETRES_REFUSES_DECODAGE_SPECULATIF,
    ),
    modele_conversation_scaleway(
        "gpt-oss-120b", "gpt-oss-120b", "OpenAI", prix_entree=0.15, prix_sortie=0.60, contexte=131072, sortie_max=32768,
        # Une image est ignorée, sans refus. none, minimal, xhigh et max refusés.
        capacites=["raisonnement"], efforts_raisonnement=["low", "medium", "high"],
    ),
    modele_conversation_scaleway(
        "llama-3.3-70b", "llama-3.3-70b-instruct", "Meta", prix_entree=0.90, prix_sortie=0.90,
        # Contexte de 131 072 jetons (100k publiés pour l'offre serverless).
        contexte=131072, sortie_max=16384, capacites=[],
    ),
    modele_conversation_scaleway(
        "gemma-4-26b", "gemma-4-26b-a4b-it", "Google", prix_entree=0.25, prix_sortie=0.50, contexte=262144, sortie_max=32768,
        capacites=["images", "raisonnement"], efforts_raisonnement=["none", "low", "medium", "high"],
    ),
    modele_conversation_scaleway(
        "qwen3-235b", "qwen3-235b-a22b-instruct-2507", "Alibaba (Qwen)", prix_entree=0.75, prix_sortie=2.25,
        # Contexte de 262 144 jetons (250k publiés).
        contexte=262144, sortie_max=16384, capacites=[],
    ),
    modele_conversation_scaleway(
        "qwen3.5-397b", "qwen3.5-397b-a17b", "Alibaba (Qwen)", prix_entree=0.60, prix_sortie=3.60,
        # Contexte de 262 144 jetons (250k publiés). Vidéos acceptées en entrée (MP4 essayé ; MPEG, MOV, OGG et WEBM publiés).
        contexte=262144, sortie_max=16384, capacites=["images", "audio_video", "raisonnement"],
        efforts_raisonnement=["none", "low", "medium", "high"],
    ),
    modele_conversation_scaleway(
        "qwen3.6-35b", "qwen3.6-35b-a3b", "Alibaba (Qwen)", prix_entree=0.25, prix_sortie=1.50, contexte=262144,
        sortie_max=32768, capacites=["images", "raisonnement"], efforts_raisonnement=["none", "low", "medium", "high"],
        # « System message must be at the beginning. », même juste après la question.
        systeme_en_tete=True,
    ),
    # Modèles que la passerelle sert aussi par OpenRouter : suffixe -scaleway, versions OpenRouter inchangées.
    modele_conversation_scaleway(
        "mistral-small-3.2-scaleway", "mistral-small-3.2-24b-instruct-2506", "Mistral AI", prix_entree=0.15, prix_sortie=0.35,
        contexte=131072, sortie_max=32768, capacites=["images"],
        # « Unexpected role 'system' after role 'assistant' » ; un système juste après la question passe.
        systeme_en_tete=True,
    ),
    modele_conversation_scaleway(
        "mistral-medium-3.5-scaleway", "mistral-medium-3.5-128b", "Mistral AI", prix_entree=1.50, prix_sortie=7.50,
        # Contexte limité à 180 000 jetons pendant la Preview.
        contexte=180000, sortie_max=16384, capacites=["images", "raisonnement"],
        # « Supported values are: ['none', 'high'] » ; sans effort, pas de raisonnement, comme avec none.
        efforts_raisonnement=["none", "high"], effort_par_defaut="none",
        # « Unexpected role 'system' after role 'assistant' ».
        systeme_en_tete=True,
    ),
    modele_conversation_scaleway(
        "glm-5.3-scaleway", "glm-5.3", "Z.ai (Zhipu)", prix_entree=1.80, prix_sortie=5.50, contexte=262144, sortie_max=24576,
        capacites=["raisonnement"], efforts_raisonnement=["none", "low", "high", "max"],
        parametres_ecartes=PARAMETRES_REFUSES_DECODAGE_SPECULATIF,
    ),
    modele_conversation_scaleway(
        "deepseek-v4-flash-scaleway", "deepseek-v4-flash-0731", "DeepSeek", prix_entree=0.40, prix_sortie=0.80, prix_cache=0.08,
        contexte=262144, sortie_max=32768, capacites=["raisonnement"],
        # Une requête sans effort compte les jetons d'entrée de high.
        efforts_raisonnement=["none", "low", "high", "max"], effort_par_defaut="high",
        parametres_ecartes=PARAMETRES_REFUSES_DECODAGE_SPECULATIF,
    ),
    modele_conversation_scaleway(
        "deepseek-v4.1-flash-1017-scaleway", "deepseek-v4.1-flash-1017", "DeepSeek", prix_entree=0.60, prix_sortie=1.80,
        prix_cache=0.12,
        # Sortie bornée à 32 768 jetons (131K publiés).
        contexte=262144, sortie_max=32768, capacites=["images", "raisonnement"],
        # minimal et medium refusés : « reasoning_effort must be low, high, xhigh, max » ; xhigh passe.
        efforts_raisonnement=["none", "low", "high", "max"],
        parametres_ecartes=PARAMETRES_REFUSES_DECODAGE_SPECULATIF,
    ),
    # Base64 et nombres rendus comme demandé ; taille réglable de 32 à 4 096 (dimensions). Contexte de 40 960 jetons par
    # texte (32k publiés), refus au-delà.
    modele_embeddings_scaleway("qwen3-embedding-8b-scaleway", "qwen3-embedding-8b", "Alibaba (Qwen)", prix_entree=0.10,
                               contexte=40960, taille=4096),
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
        # PATCH : LiteLLM fusionne ; parmi les paramètres d'appel, la route, l'adresse, la clé et les paramètres écartés
        # changent, pas les tarifs.
        acces = {k: v for k, v in modele["litellm_params"].items() if k in ("model", "api_base", "api_key", "additional_drop_params")}
        http("PATCH", f"/model/{existants[nom]['model_info']['id']}/update", {"model_info": modele["model_info"], "litellm_params": acces})
        print(f"• {nom} : informations complétées, route {acces['model']}")
    else:
        http("POST", "/model/new", modele)
        print(f"• {nom} : déclaré")
