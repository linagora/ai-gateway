"""Test de bout en bout de LiteLLM par le réseau interne (runbook, phase 5 ; à rejouer après chaque mise à jour).

Crée une équipe et une clé de test limitées à un modèle, vérifie /v1/models (critère 1),
une complétion, la dépense calculée au tarif EUR du modèle, le prix des jetons lus depuis le cache
(même requête longue envoyée deux fois), un message au format Anthropic (/v1/messages, utilisé par
des assistants de code), puis révoque la clé (critère 7 : 401) et supprime l'équipe. N'affiche
jamais la clé maître ni la clé de test. Sort en erreur si les jetons lus depuis le cache ne sont pas
comptés à leur prix déclaré, dans le coût calculé comme dans la dépense enregistrée sur la clé ; sans jeton
lu depuis le cache, ce contrôle n'est pas concluant.

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
# Requête du contrôle du cache : environ 5 000 jetons, au-delà du minimum de mise en cache des fournisseurs.
TEXTE_LONG = "\n".join(
    f"Ligne {i} : la passerelle compte chaque jeton au tarif déclaré, y compris les jetons lus depuis le cache." for i in range(1, 201)
) + "\n\nRéponds uniquement par le mot OK."


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


def cout_attendu(usage, prix_cache):
    """Coût d'une réponse au tarif du modèle ; les jetons lus depuis le cache au prix de lecture déclaré (0 sans prix)."""
    lus = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    return (usage.get("prompt_tokens", 0) - lus) * in_cost + lus * (prix_cache or 0) + usage.get("completion_tokens", 0) * out_cost


def proche(valeur, attendue):
    return abs(valeur - attendue) <= 1e-12 + 1e-6 * abs(attendue)


def depense(token):
    """Dépense enregistrée sur une clé."""
    _, ki, _ = call("GET", f"/key/info?key={token}")
    return ((ki or {}).get("info") or {}).get("spend") or 0


st, info, _ = call("GET", "/model/info")
deployments = [m for m in (info or {}).get("data", []) if m.get("model_name") == MODEL]
if not deployments:
    sys.exit(f"modèle {MODEL} introuvable dans /model/info (HTTP {st})")
mi = deployments[0].get("model_info") or {}
in_cost, out_cost = mi.get("input_cost_per_token"), mi.get("output_cost_per_token")
cache_cost = mi.get("cache_read_input_token_cost")
step(f"modèle {MODEL} : niveau {mi.get('data_level')}, devise {mi.get('pricing_currency')}, tarifs {in_cost} / {out_cost} par jeton")

st, team, _ = call("POST", "/team/new", {"team_alias": "test-install", "models": [MODEL]})
team_id = (team or {}).get("team_id")
step(f"POST /team/new → HTTP {st}")
if not team_id:
    sys.exit(json.dumps(team, ensure_ascii=False)[:500])

token_id = test_key = None
echecs = []
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
        step(f"coût calculé par LiteLLM : {hdr.get('x-litellm-response-cost')} ; attendu au tarif du modèle : {cout_attendu(usage, cache_cost):.10f}")

        for i in range(20):
            spend = depense(token_id)
            if spend > 0:
                step(f"/key/info → dépense enregistrée sur la clé : {spend:.10f} (après ~{i * 5} s)")
                break
            time.sleep(5)
        else:
            step("/key/info → dépense toujours nulle après 100 s")

    # Jetons lus depuis le cache : la même requête longue deux fois, la seconde lisant en général son début dans le cache
    # implicite du fournisseur. LiteLLM doit les compter au prix de lecture déclaré ; sans ce prix, la 1.102.1 les
    # compte à 0 €. Sans jeton lu depuis le cache, le contrôle n'est pas concluant (ce n'est pas un échec).
    longue = {"model": MODEL, "messages": [{"role": "user", "content": TEXTE_LONG}], "max_tokens": 300}
    avant = depense(token_id)
    couts = []
    for passage in range(2):
        if passage:
            time.sleep(5)
        st, comp, hdr = call("POST", "/v1/chat/completions", longue, key=test_key)
        if st != 200:
            break
        couts.append(float(hdr.get("x-litellm-response-cost") or 0))
    usage = (comp or {}).get("usage") or {}
    lus = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    step(f"cache — requête longue rejouée → HTTP {st} ; jetons : {usage.get('prompt_tokens')} entrée, dont {lus} lus depuis le cache, + {usage.get('completion_tokens')} sortie")
    if st != 200:
        echecs.append("cache (requête refusée)")
        print(json.dumps(comp, ensure_ascii=False)[:500])
    elif in_cost is None or out_cost is None:
        step("cache — non vérifié : tarifs du modèle absents")
    elif not lus:
        step("cache — non concluant : aucun jeton lu depuis le cache (le fournisseur n'a pas mis la requête en cache)")
    elif cache_cost is None:
        echecs.append("cache (prix de lecture non déclaré)")
        step("cache — échec : prix de lecture du cache non déclaré, LiteLLM compte ces jetons à 0 €")
    else:
        attendu = cout_attendu(usage, cache_cost)
        calcule = proche(couts[1], attendu)
        step(f"cache — coût calculé par LiteLLM : {couts[1]:.10f} ; attendu, jetons lus au prix de lecture du cache ({cache_cost} par jeton) : {attendu:.10f} → {'conforme' if calcule else 'échec'}")
        # La dépense enregistrée sur la clé doit compter ces jetons au même prix ; LiteLLM l'écrit en différé.
        total = avant + couts[0] + attendu
        for i in range(20):
            enregistree = depense(token_id)
            if proche(enregistree, total):
                break
            time.sleep(5)
        enregistre = proche(enregistree, total)
        step(f"cache — dépense enregistrée sur la clé : {enregistree:.10f} ; attendue : {total:.10f} → {'conforme' if enregistre else 'échec'}")
        if not (calcule and enregistre):
            echecs.append("cache (coût)")

    # Format Anthropic, utilisé par des assistants de code : LiteLLM le traduit selon la route du modèle (2026-09-26 :
    # la route openai/… de Qwen3.8 passait par l'API Responses, refusée par OVH, alors que chat/completions répondait).
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

if echecs:
    sys.exit(f"échec : {', '.join(echecs)}")
