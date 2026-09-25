"""Garde de la passerelle Linagora, exécutée par LiteLLM avant chaque appel (crochet
async_pre_call_hook de l'édition communautaire, déclaré dans config.yaml : litellm_settings.callbacks).

Liste blanche des modèles : les paramètres d'une requête priment sur ceux déclarés pour le modèle, et
LiteLLM transmet tels quels à OpenRouter ses paramètres propres : modèles de repli (models, route),
préférences de fournisseur (provider), greffons (plugins), préréglages (preset). Une requête pourrait
ainsi atteindre un modèle hors liste ou un fournisseur hors zone. Ces paramètres sont refusés, comme
les replis de LiteLLM (fallbacks…), qui contourneraient les modèles de la clé.
"""
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

PARAMETRES_INTERDITS = frozenset({
    "models", "route", "provider", "plugins", "preset", "usage", "extra_body", "additional_drop_params",
    "fallbacks", "context_window_fallbacks", "content_policy_fallbacks",
})


class GardePasserelle(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        interdits = sorted(PARAMETRES_INTERDITS.intersection(data))
        if interdits:
            raise HTTPException(status_code=400, detail={"error": f"Paramètre refusé par la passerelle Linagora : {', '.join(interdits)}. "
                                                                  "Le modèle et le fournisseur sont fixés par la passerelle."})
        return data


garde = GardePasserelle()
