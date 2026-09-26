"""Test de bout en bout de LiteLLM par le réseau interne (runbook, phase 5 ; à rejouer après chaque mise à jour).

Crée une équipe et une clé de test limitées à un modèle, vérifie /v1/models (critère 1),
une complétion, la dépense calculée au tarif EUR du modèle, un message au format Anthropic
(/v1/messages, celui de Claude Code), puis révoque la clé (critère 7 : 401) et supprime l'équipe.
N'affiche jamais la clé maître ni la clé de test.

Exécuté DANS le conteneur litellm (la clé maître y est déjà en variable d'environnement) :
  docker compose exec -T litellm python3 - <model_name> < scripts/smoke-test.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = "http://localhost:4000/admin"
MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
MODEL = sys.argv[1] if len(sys.argv) > 1 else sys.exit("usage : smoke-test.py <model_name>")


def call(method, path, body=None, key=MASTER_KEY, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        method=method,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None), {k.lower(): v for k, v in r.headers.items()}
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            payload = json.loads(raw) if raw else None
        except ValueError:
            payload = raw[:200].decode(errors="replace")
        return e.code, payload, {k.lower(): v for k, v in e.headers.items()}


def step(msg):
    print(f"• {msg}", flush=True)


st, info, _ = call("GET", "/model/info")
deployments = [m for m in (info or {}).get("data", []) if m.get("model_name") == MODEL]
if not deployments:
    sys.exit(f"modèle {MODEL} introuvable dans /model/info (HTTP {st})")
mi = deployments[0].get("model_info") or {}
in_cost, out_cost = mi.get("input_cost_per_token"), mi.get("output_cost_per_token")
step(f"modèle {MODEL} : niveau {mi.get('data_level')}, devise {mi.get('pricing_currency')}, tarifs {in_cost} / {out_cost} par jeton")

st, team, _ = call("POST", "/team/new", {"team_alias": "test-install", "models": [MODEL]})
team_id = (team or {}).get("team_id")
step(f"POST /team/new → HTTP {st}")
if not team_id:
    sys.exit(json.dumps(team, ensure_ascii=False)[:500])

token_id = test_key = None
try:
    st, gen, _ = call(
        "POST",
        "/key/generate",
        {
            "team_id": team_id,
            "models": [MODEL],
            "key_alias": "test-install-e2e",
            "duration": "1h",
            "max_budget": 1,
            "metadata": {"project": "test-install", "data_level": mi.get("data_level"), "key_type": "SERVICE"},
        },
    )
    test_key = (gen or {}).get("key")
    token_id = (gen or {}).get("token_id") or (gen or {}).get("token")
    step(f"POST /key/generate → HTTP {st} ; clé reçue : {'oui' if test_key else 'non'} ; empreinte : {'oui' if token_id else 'non'}")
    if not test_key:
        sys.exit(json.dumps(gen, ensure_ascii=False)[:500])

    st, models, _ = call("GET", "/v1/models", key=test_key)
    step(f"critère 1 — /v1/models avec la clé de test → HTTP {st}, modèles : {[m['id'] for m in (models or {}).get('data', [])]}")

    t0 = time.time()
    st, comp, hdr = call(
        "POST",
        "/v1/chat/completions",
        {"model": MODEL, "messages": [{"role": "user", "content": "Réponds uniquement par le mot OK."}], "max_tokens": 300},
        key=test_key,
    )
    usage = (comp or {}).get("usage") or {}
    content = (((comp or {}).get("choices") or [{}])[0].get("message") or {}).get("content")
    step(f"chat/completions → HTTP {st} en {time.time() - t0:.1f} s ; réponse : {str(content)[:60]!r} ; jetons : {usage.get('prompt_tokens')} entrée + {usage.get('completion_tokens')} sortie")
    if st != 200:
        print(json.dumps(comp, ensure_ascii=False)[:500])
    elif in_cost is not None and out_cost is not None:
        expected = usage.get("prompt_tokens", 0) * in_cost + usage.get("completion_tokens", 0) * out_cost
        step(f"coût calculé par LiteLLM : {hdr.get('x-litellm-response-cost')} ; attendu au tarif du modèle : {expected:.10f}")

        for i in range(20):
            st, ki, _ = call("GET", f"/key/info?key={token_id}")
            spend = ((ki or {}).get("info") or {}).get("spend") or 0
            if spend > 0:
                step(f"/key/info → dépense enregistrée sur la clé : {spend:.10f} (après ~{i * 5} s)")
                break
            time.sleep(5)
        else:
            step("/key/info → dépense toujours nulle après 100 s")

    # Format Anthropic, celui de Claude Code : LiteLLM le traduit selon la route du modèle (2026-09-26 : la route
    # openai/… de Qwen3.8 passait par l'API Responses, refusée par OVH, alors que chat/completions répondait).
    st, msg, _ = call(
        "POST",
        "/v1/messages",
        {"model": MODEL, "messages": [{"role": "user", "content": "Réponds uniquement par le mot OK."}], "max_tokens": 300},
        key=test_key,
    )
    texte = [b.get("text") for b in (msg or {}).get("content", []) if b.get("type") == "text"] if st == 200 else None
    step(f"/v1/messages (format Anthropic) → HTTP {st} ; " + (f"réponse : {str(texte)[:60]}" if st == 200 else f"erreur : {json.dumps(msg, ensure_ascii=False)[:300]}"))
finally:
    if token_id:
        st, _, _ = call("POST", "/key/delete", {"keys": [token_id]})
        step(f"POST /key/delete → HTTP {st}")
    if test_key:
        for i in range(6):
            st, _, _ = call("GET", "/v1/models", key=test_key)
            if st == 401:
                break
            time.sleep(5)
        step(f"critère 7 — /v1/models avec la clé révoquée → HTTP {st}")
    st, _, _ = call("POST", "/team/delete", {"team_ids": [team_id]})
    step(f"POST /team/delete → HTTP {st}")
