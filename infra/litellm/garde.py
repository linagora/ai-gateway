"""Garde de la passerelle Linagora, exécutée par LiteLLM avant chaque appel (crochet
async_pre_call_hook de l'édition communautaire, déclaré dans config.yaml : litellm_settings.callbacks).

Liste blanche des modèles : les paramètres d'une requête priment sur ceux déclarés pour le modèle, et
LiteLLM transmet tels quels à OpenRouter ses paramètres propres : modèles de repli (models, route),
préférences de fournisseur (provider), greffons (plugins), préréglages (preset). Une requête pourrait
ainsi atteindre un modèle hors liste ou un fournisseur hors zone. Ces paramètres sont refusés, comme
les replis de LiteLLM (fallbacks…), qui contourneraient les modèles de la clé.

API d'images et de vidéos de LiteLLM : il n'y compte pas le coût des modèles déclarés par la passerelle
(dépense enregistrée à 0 €, vérifié sur la 1.102.1), ce qui contournerait les budgets des clés. Elles sont
refusées : un modèle d'images s'appelle par la conversation, en demandant une image en sortie (modalities),
et ses jetons d'image y sont comptés au tarif déclaré.

Modèles qui cherchent sur le web à chaque requête (prix de recherche déclaré : Perplexity Sonar) : LiteLLM compte la
recherche au prix de la profondeur que demande la requête (web_search_options), de la profondeur moyenne sinon. Il la lit
à la création du journal de l'appel, avant le choix du modèle : la profondeur déclarée pour le modèle, transmise au
fournisseur, n'y est pas vue. La garde complète donc la requête de la profondeur déclarée et l'inscrit au journal : la
profondeur envoyée est celle qui est comptée. Ces modèles ne s'appellent que par /v1/chat/completions : par /v1/messages
(format Anthropic) et /v1/responses, LiteLLM ne compte pas leur recherche (vérifié sur la 1.102.1, le 2026-10-14).
"""
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

PARAMETRES_INTERDITS = frozenset({
    "models", "route", "provider", "plugins", "preset", "usage", "extra_body", "additional_drop_params",
    "fallbacks", "context_window_fallbacks", "content_policy_fallbacks",
})


# Types d'appel des API d'images et de vidéos : image_generation, aimage_edit, avideo_generation…
MOTIFS_APPELS_REFUSES = ("image", "video")

PROFONDEURS_RECHERCHE = ("low", "medium", "high")


def declaration_recherche(modele):
    """Paramètres déclarés d'un modèle qui cherche sur le web à chaque requête (prix de recherche déclaré), None sinon."""
    from litellm.proxy.proxy_server import llm_router

    for deploiement in (llm_router.get_model_list(model_name=modele) if llm_router is not None and modele else None) or []:
        parametres = deploiement.get("litellm_params") or {}
        if parametres.get("search_context_cost_per_query"):
            return parametres
    return None


class GardePasserelle(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if any(motif in str(call_type) for motif in MOTIFS_APPELS_REFUSES):
            raise HTTPException(status_code=400, detail={"error": "API refusée par la passerelle Linagora. Pour créer une image, appelez "
                                                                  "/v1/chat/completions en demandant une image en sortie : \"modalities\": [\"image\"]. "
                                                                  "La génération de vidéos n'est pas proposée."})
        interdits = sorted(PARAMETRES_INTERDITS.intersection(data))
        if interdits:
            raise HTTPException(status_code=400, detail={"error": f"Paramètre refusé par la passerelle Linagora : {', '.join(interdits)}. "
                                                                  "Le modèle et le fournisseur sont fixés par la passerelle."})
        declaration = declaration_recherche(data.get("model"))
        if declaration is not None:
            if call_type != "acompletion":
                raise HTTPException(status_code=400, detail={"error": "API refusée par la passerelle LINAGORA pour ce modèle, qui cherche sur le web à "
                                                                      "chaque requête : appelez /v1/chat/completions, où sa recherche est comptée."})
            options = dict(data.get("web_search_options") or {})
            if options.get("search_context_size") not in PROFONDEURS_RECHERCHE:
                options["search_context_size"] = (declaration.get("web_search_options") or {}).get("search_context_size", "medium")
            data["web_search_options"] = options
            data["litellm_logging_obj"].standard_built_in_tools_params["web_search_options"] = options
        return data


garde = GardePasserelle()
