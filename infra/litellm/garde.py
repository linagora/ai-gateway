"""Garde de la passerelle Linagora, exécutée par LiteLLM avant chaque appel (crochet
async_pre_call_hook de l'édition communautaire, déclaré dans config.yaml : litellm_settings.callbacks).

Liste blanche des modèles : les paramètres d'une requête priment sur ceux déclarés pour le modèle, et
LiteLLM transmet tels quels à OpenRouter ses paramètres propres : modèles de repli (models, route),
préférences de fournisseur (provider), greffons (plugins), préréglages (preset). Une requête pourrait
ainsi atteindre un modèle hors liste ou un fournisseur hors zone. Ces paramètres sont refusés, comme
les replis de LiteLLM (fallbacks…), qui contourneraient les modèles de la clé.

Modèles d'OpenRouter par /v1/messages (format Anthropic) et /v1/responses : LiteLLM les envoie à l'API Responses
d'OpenRouter sans les préférences de fournisseur déclarées pour le modèle (provider : zone d'exécution, plafond de prix),
qu'il ne transmet que par /v1/chat/completions ; OpenRouter y choisit alors un fournisseur hors de ces préférences
(1.102.1, vérifié le 2026-11-21 par l'API /generation d'OpenRouter). Le réglage use_chat_completions_url_for_anthropic_messages
de LiteLLM n'y suffit pas : une requête /v1/messages avec raisonnement (thinking) repasse par l'API Responses. Ces deux API
sont donc refusées pour un modèle qui déclare des préférences de fournisseur.

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

Réponses en flux (stream) : LiteLLM y reprend le coût que renvoie le fournisseur (usage.cost, qu'OpenRouter donne en dollars,
à son tarif) au lieu de compter les jetons au tarif déclaré pour le modèle, comme il le fait hors flux (mesuré sur la 1.102.1
le 2026-10-15 : 7,7 % de plus ; même code sur la branche principale de LiteLLM). Au chargement de la garde, LiteLLM est réglé
pour suivre en flux la même règle que hors flux : le coût renvoyé par le fournisseur est écarté pour un modèle à tarif déclaré.

Modèles qui n'acceptent de message système qu'en tête de la conversation (model_info.systeme_en_tete : Qwen3.8 chez
OVHcloud, dont le gabarit refuse les autres, et des modèles de Scaleway) : Claude Code envoie par /v1/messages des
entrées « system » au milieu de la conversation (son environnement, après la première question ; 2.1.314), que LiteLLM
transmet à leur place (1.102.1). La garde les rattache au message de l'utilisateur qui les précède, entre balises
<system-reminder>, comme Claude Code le fait de ses rappels.

Transcriptions (/v1/audio/transcriptions) : LiteLLM les compte à la durée de l'audio, qu'il lit avec la bibliothèque
soundfile, et à 0 € sans erreur s'il ne la lit pas (1.102.1). La garde lit la durée avant l'appel, avec la fonction de
LiteLLM, puis remet le fichier à son début ; si elle ne la lit pas, elle refuse l'appel. Dans l'image amd64 de la 1.102.1,
celle de la production (libsndfile 1.2.0 livrée avec soundfile, compilée avec MP3), soundfile lit WAV, FLAC, MP3, OGG
(Vorbis, Opus) et AIFF, mais ni M4A, ni MP4, ni WebM (essayés le 2026-11-21), que Scaleway accepte pourtant. Le refus
n'annonce que les formats que Scaleway a aussi transcrits : ni OGG Vorbis, pas essayé, ni AIFF, absent de sa liste.
L'image arm64, sous le même digest (postes Mac), prend la libsndfile 1.2.2 du système, compilée sans MP3 : le MP3 y est
refusé.
"""
import sys

import litellm
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger
from litellm.litellm_core_utils.audio_utils.utils import calculate_request_duration
from litellm.litellm_core_utils.litellm_logging import use_custom_pricing_for_model

PARAMETRES_INTERDITS = frozenset({
    "models", "route", "provider", "plugins", "preset", "usage", "extra_body", "additional_drop_params",
    "fallbacks", "context_window_fallbacks", "content_policy_fallbacks",
})


# Types d'appel des API d'images et de vidéos : image_generation, aimage_edit, avideo_generation…
MOTIFS_APPELS_REFUSES = ("image", "video")

PROFONDEURS_RECHERCHE = ("low", "medium", "high")

# Refus de /v1/messages et de /v1/responses pour un modèle qui déclare des préférences de fournisseur (voir plus haut).
REFUS_API_RESPONSES = (
    "API refusée par la passerelle LINAGORA pour ce modèle d'OpenRouter : /v1/messages et /v1/responses n'y transmettent "
    "pas la zone d'exécution. Appelez /v1/chat/completions."
)

# Refus d'un fichier audio dont la durée est illisible, en français et en anglais : formats lus par soundfile dans l'image
# de LiteLLM de la production et transcrits par Scaleway (voir plus haut).
REFUS_FORMAT_AUDIO = (
    "Fichier audio refusé par la passerelle LINAGORA : sa durée, qui fixe le prix de la transcription, est illisible. "
    "Formats acceptés : WAV, FLAC, MP3 et OGG Opus ; M4A, MP4 et WebM ne le sont pas. "
    "/ Audio file refused by the LINAGORA gateway: its duration, which sets the transcription price, cannot be read. "
    "Accepted formats: WAV, FLAC, MP3 and OGG Opus; M4A, MP4 and WebM are not."
)


class RefusDeLaGarde(HTTPException):
    """Refus de la garde (400), dont le message d'erreur est le texte seul. LiteLLM 1.102.1 (lu et essayé le 2026-11-22) le
    prend dans l'attribut message de l'exception, s'il existe, sur les transcriptions, les images, /v1/completions et
    d'autres API : à défaut, il y met detail converti en texte, précédé de « 400: » sur les images et /v1/completions. Sur
    la conversation, les embeddings, /v1/messages et /v1/responses, il le prend dans detail, qu'il recopie dans
    provider_specific_fields s'il est un dictionnaire. type et param suivent le format d'OpenAI : les transcriptions et
    /v1/completions les rendraient sinon en texte (« None »). Sur /v1/audio/speech, où la passerelle ne déclare aucun
    modèle, LiteLLM laisse l'exception à FastAPI, qui répond {"detail": texte}."""

    type = "invalid_request_error"
    param = None

    def __init__(self, texte):
        super().__init__(status_code=400, detail=texte)
        self.message = texte


def declaration_recherche(modele):
    """Paramètres déclarés d'un modèle qui cherche sur le web à chaque requête (prix de recherche déclaré), None sinon."""
    from litellm.proxy.proxy_server import llm_router

    for deploiement in (llm_router.get_model_list(model_name=modele) if llm_router is not None and modele else None) or []:
        parametres = deploiement.get("litellm_params") or {}
        if parametres.get("search_context_cost_per_query"):
            return parametres
    return None


def appliquer_tarif_declare_en_flux():
    """Coût des réponses en flux au tarif déclaré. LiteLLM décide de reprendre le coût renvoyé par le fournisseur dans
    _reported_cost_is_priced_by_calculator, à côté de stream_chunk_builder : sinon, il calcule le coût comme hors flux."""
    module = sys.modules[litellm.stream_chunk_builder.__module__]
    origine = getattr(module, "_reported_cost_is_priced_by_calculator", None)
    if origine is None:
        # Version de LiteLLM qui ne décide plus là : la garde reste active, et la recette en flux (smoke-test.py) le signale.
        print("Garde de la passerelle LINAGORA : coût des réponses en flux non corrigé, _reported_cost_is_priced_by_calculator "
              "introuvable dans cette version de LiteLLM.", file=sys.stderr, flush=True)
        return

    def cout_au_tarif_declare(logging_obj):
        return origine(logging_obj) or (logging_obj is not None and use_custom_pricing_for_model(getattr(logging_obj, "litellm_params", None)))

    module._reported_cost_is_priced_by_calculator = cout_au_tarif_declare


appliquer_tarif_declare_en_flux()


def preferences_fournisseur_declarees(modele):
    """Vrai si un déploiement du modèle déclare des préférences de fournisseur d'OpenRouter (litellm_params.provider)."""
    from litellm.proxy.proxy_server import llm_router

    deploiements = (llm_router.get_model_list(model_name=modele) if llm_router is not None and modele else None) or []
    return any((deploiement.get("litellm_params") or {}).get("provider") for deploiement in deploiements)


def systeme_en_tete(modele):
    """Vrai si le modèle n'accepte de message système qu'en tête de la conversation (model_info.systeme_en_tete)."""
    from litellm.proxy.proxy_server import llm_router

    deploiements = (llm_router.get_model_list(model_name=modele) if llm_router is not None and modele else None) or []
    return any((deploiement.get("model_info") or {}).get("systeme_en_tete") for deploiement in deploiements)


def rappels_systeme(messages):
    """Messages au format Anthropic sans entrée « system » : le texte de chacune, entre balises <system-reminder>, rejoint
    le message de l'utilisateur qui la précède, ou un nouveau message de l'utilisateur après une réponse du modèle."""
    resultat = []
    for message in messages:
        if message.get("role") != "system":
            resultat.append(message)
            continue
        contenu = message.get("content")
        textes = [contenu] if isinstance(contenu, str) else [bloc.get("text") for bloc in contenu or [] if isinstance(bloc, dict) and bloc.get("type") == "text"]
        texte = "\n\n".join(t for t in textes if t)
        if not texte:
            continue
        rappel = {"type": "text", "text": f"<system-reminder>\n{texte}\n</system-reminder>"}
        precedent = resultat[-1] if resultat else None
        if precedent is not None and precedent.get("role") == "user":
            blocs = precedent.get("content")
            blocs = [{"type": "text", "text": blocs}] if isinstance(blocs, str) else list(blocs or [])
            resultat[-1] = {**precedent, "content": [*blocs, rappel]}
        else:
            resultat.append({"role": "user", "content": [rappel]})
    return resultat


class GardePasserelle(CustomLogger):
    async def async_pre_call_hook(self, user_api_key_dict, cache, data, call_type):
        if any(motif in str(call_type) for motif in MOTIFS_APPELS_REFUSES):
            raise RefusDeLaGarde("API refusée par la passerelle LINAGORA. Pour créer une image, appelez "
                                 "/v1/chat/completions en demandant une image en sortie : \"modalities\": [\"image\"]. "
                                 "La génération de vidéos n'est pas proposée.")
        interdits = sorted(PARAMETRES_INTERDITS.intersection(data))
        if interdits:
            raise RefusDeLaGarde(f"Paramètre refusé par la passerelle LINAGORA : {', '.join(interdits)}. "
                                 "Le modèle et le fournisseur sont fixés par la passerelle.")
        if any(motif in str(call_type) for motif in ("anthropic_messages", "responses")) and preferences_fournisseur_declarees(data.get("model")):
            raise RefusDeLaGarde(REFUS_API_RESPONSES)
        if "transcription" in str(call_type):
            # Le fichier, lu en entier par LiteLLM, est dans la requête (io.BytesIO) avant l'appel des crochets.
            if calculate_request_duration(data.get("file")) is None:
                raise RefusDeLaGarde(REFUS_FORMAT_AUDIO)
            data["file"].seek(0)
        if call_type == "anthropic_messages" and systeme_en_tete(data.get("model")):
            data["messages"] = rappels_systeme(data.get("messages") or [])
        declaration = declaration_recherche(data.get("model"))
        if declaration is not None:
            if call_type != "acompletion":
                raise RefusDeLaGarde("API refusée par la passerelle LINAGORA pour ce modèle, qui cherche sur le web à "
                                     "chaque requête : appelez /v1/chat/completions, où sa recherche est comptée.")
            options = dict(data.get("web_search_options") or {})
            if options.get("search_context_size") not in PROFONDEURS_RECHERCHE:
                options["search_context_size"] = (declaration.get("web_search_options") or {}).get("search_context_size", "medium")
            data["web_search_options"] = options
            data["litellm_logging_obj"].standard_built_in_tools_params["web_search_options"] = options
        return data


garde = GardePasserelle()
