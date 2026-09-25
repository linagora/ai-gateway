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
"""
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

PARAMETRES_INTERDITS = frozenset({
    "models", "route", "provider", "plugins", "preset", "usage", "extra_body", "additional_drop_params",
    "fallbacks", "context_window_fallbacks", "content_policy_fallbacks",
})


# Types d'appel des API d'images et de vidéos : image_generation, aimage_edit, avideo_generation…
MOTIFS_APPELS_REFUSES = ("image", "video")


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
        return data


garde = GardePasserelle()
