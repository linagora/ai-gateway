"""JEV (Typesafe, niveau Expérimental) comme modèle de la passerelle : fournisseur personnalisé de
LiteLLM (CustomLLM, édition communautaire), déclaré dans config.yaml (litellm_settings.custom_provider_map).

JEV n'est pas un modèle de conversation : son API System One reçoit un état et des questions typées,
et renvoie des réponses structurées. Convention de la passerelle : le dernier message contient la
requête System One en JSON, sans le champ « model » ; la réponse du modèle est le JSON renvoyé par
Typesafe (modèle et réponses). Les clés, budgets et coûts sont ceux de LiteLLM, comme pour tout
modèle (coût calculé sur les jetons d'entrée et de sortie comptés par Typesafe).

  {"model": "jev-latest", "messages": [{"role": "user", "content":
    "{\"state\": \"…\", \"questions\": {\"urgent\": {\"type\": \"noul\", \"instructions\": \"…\"}}}"}]}
"""
import json
import os
import time

import httpx
from litellm import CustomLLM, ModelResponse
from litellm.llms.custom_llm import CustomLLMError

API_PAR_DEFAUT = "https://api.typesafe.ai/v1"
FORMAT = ('JEV attend dans le dernier message la requête System One de Typesafe en JSON : '
          '{"state": …, "questions": {…}} (voir https://docs.typesafe.ai/api).')


def requete(model, messages, api_base, api_key):
    try:
        contenu = json.loads(messages[-1]["content"])
    except (KeyError, IndexError, TypeError, ValueError):
        raise CustomLLMError(status_code=400, message=FORMAT)
    if not isinstance(contenu, dict) or "state" not in contenu or not isinstance(contenu.get("questions"), dict):
        raise CustomLLMError(status_code=400, message=FORMAT)
    return {
        "url": f"{(api_base or API_PAR_DEFAUT).rstrip('/')}/systemone",
        "json": {**contenu, "model": model},
        "headers": {"Authorization": f"Bearer {api_key or os.environ['TYPESAFE_API_KEY']}"},
    }


def reponse(r: httpx.Response, model: str) -> ModelResponse:
    if r.status_code != 200:
        raise CustomLLMError(status_code=r.status_code, message=f"Typesafe : {r.text[:500]}")
    corps = r.json()
    usage = corps.get("usage") or {}
    entree, sortie = usage.get("input_tokens", 0), usage.get("output_tokens", 0)
    return ModelResponse(
        model=model,
        created=int(time.time()),
        choices=[{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps(
            {"model": corps.get("model"), "answers": corps.get("answers")}, ensure_ascii=False)}}],
        usage={"prompt_tokens": entree, "completion_tokens": sortie, "total_tokens": entree + sortie},
    )


class Jev(CustomLLM):
    def completion(self, model, messages, api_base, custom_prompt_dict, model_response, print_verbose, encoding, api_key,
                   logging_obj, optional_params, acompletion=None, litellm_params=None, logger_fn=None, headers={}, timeout=None,
                   client=None):
        with httpx.Client(timeout=timeout or 120) as c:
            return reponse(c.post(**requete(model, messages, api_base, api_key)), model)

    async def acompletion(self, model, messages, api_base, custom_prompt_dict, model_response, print_verbose, encoding, api_key,
                          logging_obj, optional_params, acompletion=None, litellm_params=None, logger_fn=None, headers={},
                          timeout=None, client=None):
        async with httpx.AsyncClient(timeout=timeout or 120) as c:
            return reponse(await c.post(**requete(model, messages, api_base, api_key)), model)

    async def astreaming(self, model, messages, api_base, custom_prompt_dict, model_response, print_verbose, encoding, api_key,
                         logging_obj, optional_params, acompletion=None, litellm_params=None, logger_fn=None, headers={},
                         timeout=None, client=None):
        # Pas de flux côté Typesafe : la réponse complète est rendue en un seul morceau.
        r = await self.acompletion(model, messages, api_base, custom_prompt_dict, model_response, print_verbose, encoding,
                                   api_key, logging_obj, optional_params, timeout=timeout)
        yield {"text": r.choices[0].message.content, "is_finished": True, "finish_reason": "stop", "index": 0,
               "tool_use": None, "usage": {"prompt_tokens": r.usage.prompt_tokens, "completion_tokens": r.usage.completion_tokens,
                                           "total_tokens": r.usage.total_tokens}}


jev = Jev()
