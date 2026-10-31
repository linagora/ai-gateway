"""Test de bout en bout de LiteLLM par le réseau interne (runbook, phase 5 ; à rejouer après chaque mise à jour).

Crée une équipe et une clé de test limitées à un modèle, vérifie /v1/models (critère 1),
une complétion, la dépense calculée au tarif EUR du modèle, le prix des jetons lus depuis le cache
(même requête longue envoyée deux fois), un message au format Anthropic (/v1/messages, utilisé par
des assistants de code), puis une requête telle que l'envoie Claude Code (en-têtes anthropic-beta, système en
blocs, outils, metadata.user_id, réflexion, context_management) : en flux, avec les événements SSE du message et de
ses blocs de contenu et la dépense enregistrée sur la clé au coût des jetons du flux (les budgets s'appliquent aux
appels de Claude Code), puis sans flux avec un appel d'outil demandé, auquel le modèle doit répondre par un bloc
tool_use ; enfin révoque la clé (critère 7 : 401) et supprime l'équipe. N'affiche
jamais la clé maître ni la clé de test. Sort en erreur si les jetons lus depuis le cache ne sont pas
comptés à leur prix déclaré, dans le coût calculé comme dans la dépense enregistrée sur la clé ; sans jeton
lu depuis le cache, ce contrôle n'est pas concluant. Sort aussi en erreur si /v1/models ne donne pas le
modèle à la clé de test (critère 1), ou si la clé révoquée n'est pas refusée (critère 7).

La même question est aussi posée en flux (stream), comme le font les assistants de code et les interfaces de conversation :
la dépense enregistrée sur la clé doit suivre le tarif déclaré, comme hors flux. La recette sort en erreur sinon.

Un modèle d'embeddings (type d'API « embeddings ») passe à la place par /v1/embeddings : deux vecteurs de la
taille déclarée, au format base64 des SDK OpenAI puis sans format ; avec une taille réduite (dimensions), des
vecteurs de cette taille pour un modèle qui l'accepte, un refus explicite (400) pour les autres ; la dépense
enregistrée sur la clé, au prix d'entrée déclaré. La recette sort en erreur si l'un de ces contrôles échoue.

Une API de décision (type d'API « decision » : JEV, Nox-4B) reçoit à la place une requête System One : une réponse par
question, sans erreur ; le coût calculé et la dépense enregistrée sur la clé, au tarif déclaré ; un message hors format
refusé explicitement (400). La recette sort en erreur si l'un de ces contrôles échoue.

Un modèle qui cherche sur le web à chaque requête (prix de recherche déclaré : Perplexity Sonar) reçoit en plus une
question sans profondeur de recherche, puis avec des options sans profondeur (la garde applique celle de la déclaration),
puis à la profondeur « high » : coût calculé et dépense enregistrée sur la clé au prix déclaré, coût facturé par
OpenRouter (converti en euros) à 2 % près ; /v1/messages et /v1/responses, où sa recherche ne serait pas comptée, doivent
être refusés par la garde. Une réponse qui cite des sources du web, pour un modèle sans prix de recherche déclaré, est un
échec : sa recherche ne serait pas comptée.

Exécuté DANS le conteneur litellm (la clé maître y est déjà en variable d'environnement) :
  docker compose exec -T litellm python3 - <model_name> < scripts/smoke-test.py
"""
import base64
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


def flux(chemin, corps, key, en_tetes=None, timeout=120):
    """Appel en flux (SSE) : lit le corps brut et rend le statut, le content-type, les événements reçus
    (objets des lignes « data: {"type": …} ») et le corps décodé (le début sert à afficher une erreur)."""
    req = urllib.request.Request(
        BASE + chemin,
        data=json.dumps(corps).encode(),
        method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", **(en_tetes or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            statut, type_contenu, brut = r.status, r.headers.get("content-type", ""), r.read()
    except urllib.error.HTTPError as e:
        statut, type_contenu, brut = e.code, e.headers.get("content-type", ""), e.read()
    evenements = []
    for ligne in brut.decode(errors="replace").splitlines():
        if ligne.startswith("data:"):
            try:
                evenement = json.loads(ligne[5:].strip())
            except ValueError:
                continue
            if isinstance(evenement, dict):
                evenements.append(evenement)
    return statut, type_contenu, evenements, brut.decode(errors="replace")


def step(msg):
    print(f"• {msg}", flush=True)


def cout_attendu(usage, prix_cache, profondeur=None):
    """Coût d'une réponse au tarif du modèle ; les jetons lus depuis le cache au prix de lecture déclaré (0 sans prix) ; la
    recherche sur le web au prix déclaré de sa profondeur (par défaut, celle de la déclaration), s'il y en a un."""
    lus = (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
    recherche = prix_recherche.get(f"search_context_size_{profondeur or profondeur_recherche}", 0)
    return (usage.get("prompt_tokens", 0) - lus) * in_cost + lus * (prix_cache or 0) + usage.get("completion_tokens", 0) * out_cost + recherche


def citations(reponse):
    """Sources du web citées par une réponse de conversation (annotations url_citation) : signe d'une recherche."""
    message = (((reponse or {}).get("choices") or [{}])[0].get("message") or {})
    return [a for a in message.get("annotations") or [] if a.get("type") == "url_citation"]


def proche(valeur, attendue):
    return abs(valeur - attendue) <= 1e-12 + 1e-6 * abs(attendue)


def depense(token):
    """Dépense enregistrée sur une clé."""
    _, ki, _ = call("GET", f"/key/info?key={token}")
    return ((ki or {}).get("info") or {}).get("spend") or 0


# Deux textes : un vecteur par texte.
TEXTES = ["La passerelle compte chaque jeton au tarif déclaré.", "Un modèle d'embeddings rend un vecteur par texte."]
# Modèles dont OVH accepte une taille réduite (dimensions), vérifié le 2026-10-04 ; les autres doivent la refuser (400).
TAILLE_REGLABLE = {"qwen3-embedding-8b"}


def tailles(reponse):
    """Taille de chaque vecteur reçu, en nombres ou en base64 (nombres flottants sur 4 octets, comme les SDK OpenAI)."""
    return [len(base64.b64decode(v)) // 4 if isinstance(v, str) else len(v or []) for v in (d.get("embedding") for d in (reponse or {}).get("data", []))]


def vectoriser(parametres, test_key):
    """Appel de /v1/embeddings sur les deux textes : statut, réponse, taille de chaque vecteur, jetons d'entrée comptés."""
    st, rep, _ = call("POST", "/v1/embeddings", {"model": MODEL, "input": TEXTES, **parametres}, key=test_key)
    if st != 200:
        return st, rep, [], 0
    return st, rep, tailles(rep), ((rep or {}).get("usage") or {}).get("prompt_tokens") or 0


def attendre_depense(token_id, attendue):
    """Dépense enregistrée sur la clé, relue jusqu'à la valeur attendue : LiteLLM l'écrit en différé."""
    for _ in range(20):
        enregistree = depense(token_id)
        if proche(enregistree, attendue):
            break
        time.sleep(5)
    return enregistree


# Requête de Claude Code 2.1.312 (capturée) : en-têtes, puis corps (système en blocs, outil, identifiant de session, réflexion).
# Depuis la 2.1.314 au moins, l'environnement suit la question dans une entrée « system » (ticket #159).
EN_TETES_CLAUDE_CODE = {
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,effort-2025-11-24",
}
# Événements d'une réponse en flux de l'API Messages, dans leur ordre : le contenu de la réponse, texte ou appel d'outil,
# n'arrive que par les événements de ses blocs (content_block_*).
EVENEMENTS_DU_FLUX = ("message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop")


def requete_claude_code(question, flux_sse):
    return {
        "model": MODEL,
        "max_tokens": 300,
        "stream": flux_sse,
        "system": [
            {"type": "text", "text": "x-anthropic-billing-header: cc_version=2.1.312; cc_entrypoint=cli;"},
            {"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude.", "cache_control": {"type": "ephemeral"}},
        ],
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": question}]},
            {"role": "system", "content": [{"type": "text", "text": "# Environment\n - Platform: linux"}]},
        ],
        "tools": [{
            "name": "Read",
            "description": "Reads a file from the local filesystem.",
            "input_schema": {"type": "object", "properties": {"file_path": {"type": "string"}}, "required": ["file_path"]},
        }],
        "metadata": {"user_id": json.dumps({"device_id": "smoke-test", "account_uuid": "", "session_id": "smoke-test"})},
        "thinking": {"type": "adaptive", "display": "omitted"},
        "output_config": {"effort": "high"},
        "context_management": {"edits": [{"type": "clear_thinking_20251015", "keep": "all"}]},
    }


def usage_du_flux(evenements):
    """Usage d'un flux Anthropic (message_start, puis message_delta) converti en clés de chat/completions ; None s'il manque."""
    usage = {}
    for evenement in evenements:
        brut = (evenement.get("message") or {}).get("usage") if evenement.get("type") == "message_start" else evenement.get("usage")
        if isinstance(brut, dict):
            usage.update({k: v for k, v in brut.items() if isinstance(v, int)})
    if "output_tokens" not in usage:
        return None
    lus = usage.get("cache_read_input_tokens", 0)
    return {"prompt_tokens": usage.get("input_tokens", 0) + lus + usage.get("cache_creation_input_tokens", 0),
            "completion_tokens": usage["output_tokens"], "prompt_tokens_details": {"cached_tokens": lus}}


def controle_claude_code(test_key, token_id, echecs):
    """/v1/messages tel que l'envoie Claude Code : en flux (événements SSE, dépense enregistrée), puis sans flux avec un outil."""
    avant = depense(token_id)
    st, type_contenu, evenements, debut = flux(
        "/v1/messages?beta=true", requete_claude_code("Réponds uniquement par le mot OK.", True), test_key, EN_TETES_CLAUDE_CODE)
    types = {e.get("type") for e in evenements}
    manquants = [t for t in EVENEMENTS_DU_FLUX if t not in types]
    conforme = st == 200 and "text/event-stream" in type_contenu and not manquants
    step(f"/v1/messages tel que l'envoie Claude Code, en flux → HTTP {st} ; {type_contenu or 'sans content-type'} ; "
         f"événements : {sorted(t for t in types if t)}" + (f" ; manquants : {manquants}" if manquants else "")
         + f" → {'conforme' if conforme else 'échec'}")
    if not conforme:
        print(debut[:300])
        echecs.append("Claude Code (flux)")
    # Les budgets des clés ne s'appliquent aux appels de Claude Code que si le flux est compté sur la clé : la dépense
    # enregistrée (en différé) doit augmenter du coût des jetons du flux.
    if st != 200:
        step("Claude Code, dépense du flux — non vérifiée : flux refusé")
    elif not in_cost or not out_cost:
        step("Claude Code, dépense du flux — non vérifiée : tarifs du modèle absents")
    else:
        usage = usage_du_flux(evenements)
        attendu = None if usage is None else cout_attendu(usage, cache_cost)
        apres = avant
        for i in range(20):
            apres = depense(token_id)
            if (attendu is None and apres > avant) or (attendu is not None and proche(apres - avant, attendu)):
                break
            if i < 19:
                time.sleep(5)
        conforme = apres > avant if attendu is None else proche(apres - avant, attendu)
        step(f"Claude Code, dépense du flux : {avant:.10f} avant, {apres:.10f} après ; "
             + ("jetons du flux introuvables, hausse seule contrôlée" if attendu is None else f"attendue : {avant + attendu:.10f}")
             + f" → {'conforme' if conforme else 'échec'}")
        if not conforme:
            echecs.append("Claude Code (dépense du flux)")
    # Sans flux, avec un appel d'outil demandé : Claude Code lit les fichiers et agit par les blocs tool_use de la réponse,
    # qui sont donc exigés.
    st, _, _, brut = flux(
        "/v1/messages?beta=true", requete_claude_code("Appelle l'outil Read sur /etc/hostname.", False), test_key, EN_TETES_CLAUDE_CODE)
    try:
        outil = any(b.get("type") == "tool_use" for b in json.loads(brut).get("content", []))
    except (ValueError, AttributeError, TypeError):
        outil = False
    conforme = st == 200 and outil
    step(f"/v1/messages tel que l'envoie Claude Code, sans flux, outil Read demandé → HTTP {st} ; bloc tool_use : "
         f"{'oui' if outil else 'non'} → {'conforme' if conforme else 'échec'}")
    if not conforme:
        print(brut[:300])
        echecs.append("Claude Code (outil)")


def controle_embeddings(test_key, token_id, echecs):
    """Vecteurs de la taille déclarée, quel que soit le format ; taille réduite tenue ou refusée ; dépense au prix d'entrée."""
    taille, avant, jetons = mi.get("output_vector_size"), depense(token_id), 0
    for nom, parametres in (("format base64 des SDK", {"encoding_format": "base64"}), ("sans format", {})):
        st, rep, recues, comptes = vectoriser(parametres, test_key)
        jetons += comptes
        conforme = st == 200 and recues == [taille] * len(TEXTES)
        step(f"embeddings, {nom} → HTTP {st} ; tailles des vecteurs : {recues} ; attendues : {[taille] * len(TEXTES)} → {'conforme' if conforme else 'échec'}")
        if st != 200:
            print(json.dumps(rep, ensure_ascii=False)[:500])
        if not conforme:
            echecs.append(f"embeddings ({nom})")
    # Taille réduite : tenue par un modèle qui l'accepte, refusée explicitement par les autres ; jamais d'autre taille.
    reglable = MODEL in TAILLE_REGLABLE
    st, rep, recues, comptes = vectoriser({"dimensions": 256}, test_key)
    jetons += comptes
    conforme = (st == 200 and recues == [256] * len(TEXTES)) if reglable else st == 400
    detail = f"tailles des vecteurs : {recues}" if st == 200 else f"refus : {json.dumps(rep, ensure_ascii=False)[:200]}"
    step(f"embeddings, dimensions 256 ({'à tenir' if reglable else 'à refuser'}) → HTTP {st} ; {detail} → {'conforme' if conforme else 'échec'}")
    if not conforme:
        echecs.append("embeddings (dimensions)")
    # LiteLLM 1.102.1 ne renvoie pas le coût d'une réponse d'embeddings dans ses en-têtes : seule la dépense enregistrée
    # sur la clé se contrôle.
    if in_cost is None:
        echecs.append("embeddings (tarif d'entrée absent)")
        step("embeddings — dépense non vérifiée : tarif d'entrée absent")
        return
    attendue = avant + jetons * in_cost
    enregistree = attendre_depense(token_id, attendue)
    conforme = proche(enregistree, attendue)
    step(f"embeddings — dépense enregistrée sur la clé : {enregistree:.10f} ; attendue, {jetons} jetons d'entrée à {in_cost} : {attendue:.10f} → {'conforme' if conforme else 'échec'}")
    if not conforme:
        echecs.append("embeddings (dépense)")


# Requête System One d'une API de décision : une situation et deux questions typées, dans le dernier message.
DECISION = {
    "state": "Le disque du serveur est plein et les écritures échouent depuis ce matin.",
    "questions": {
        "urgent": {"type": "noul", "instructions": "Une action immédiate est-elle requise ?"},
        "composant": {"type": "choice", "instructions": "Quel composant est en cause ?",
                      "criteria": {"reseau": "Réseau", "disque": "Disque et stockage", "application": "Application"}},
    },
}


def controle_decision(test_key, token_id, echecs):
    """Une réponse par question, sans erreur ; coût et dépense au tarif déclaré ; un message hors format refusé (400)."""
    avant = depense(token_id)
    corps = {"model": MODEL, "messages": [{"role": "user", "content": json.dumps(DECISION, ensure_ascii=False)}]}
    st, rep, hdr = call("POST", "/v1/chat/completions", corps, key=test_key)
    try:
        reponses = json.loads(rep["choices"][0]["message"]["content"])["answers"]
    except (TypeError, KeyError, IndexError, ValueError):
        reponses = None
    # Une question refusée (budget de jetons dépassé…) porte un champ error, sous un statut 200.
    conforme = isinstance(reponses, dict) and set(reponses) == set(DECISION["questions"]) and not any(
        isinstance(r, dict) and r.get("error") for r in reponses.values())
    step(f"décision System One → HTTP {st} ; réponses : {json.dumps(reponses if st == 200 else rep, ensure_ascii=False)[:300]} "
         f"→ {'conforme' if conforme else 'échec'}")
    if not conforme:
        echecs.append("décision (réponses)")
    if st == 200 and (in_cost is None or out_cost is None):
        echecs.append("décision (tarifs absents)")
        step("décision — coût non vérifié : tarifs du modèle absents")
    elif st == 200:
        usage = rep.get("usage") or {}
        attendu = cout_attendu(usage, cache_cost)
        calcule = float(hdr.get("x-litellm-response-cost") or 0)
        enregistree = attendre_depense(token_id, avant + attendu)
        conforme = proche(calcule, attendu) and proche(enregistree, avant + attendu)
        step(f"décision — jetons : {usage.get('prompt_tokens')} entrée + {usage.get('completion_tokens')} sortie ; coût calculé : "
             f"{calcule:.10f}, dépense enregistrée : {enregistree:.10f} ; attendus : {attendu:.10f}, {avant + attendu:.10f} "
             f"→ {'conforme' if conforme else 'échec'}")
        if not conforme:
            echecs.append("décision (coût)")
    # Message hors format : un refus explicite, qui rappelle le format attendu.
    st, rep, _ = call("POST", "/v1/chat/completions", {"model": MODEL, "messages": [{"role": "user", "content": "Bonjour"}]}, key=test_key)
    conforme = st == 400 and "System One" in json.dumps(rep, ensure_ascii=False)
    step(f"décision, message hors format → HTTP {st} ; {json.dumps(rep, ensure_ascii=False)[:200]} → {'conforme' if conforme else 'échec'}")
    if not conforme:
        echecs.append("décision (message hors format)")


def controle_flux(test_key, token_id, echecs):
    """Question posée en flux : dépense enregistrée sur la clé au tarif déclaré, comme hors flux (LiteLLM 1.102.1 y reprenait
    le coût renvoyé par OpenRouter, en dollars, au lieu des prix déclarés ; corrigé par la garde)."""
    avant = depense(token_id)
    corps = {"model": MODEL, "messages": [{"role": "user", "content": "Réponds uniquement par le mot OK."}], "max_tokens": 300,
             "stream": True, "stream_options": {"include_usage": True}}
    st, _, morceaux, brut = flux("/v1/chat/completions", corps, test_key)
    if st != 200:
        echecs.append("flux (requête refusée)")
        step(f"flux → HTTP {st} ; {brut[:300]}")
        return
    usage = next((m["usage"] for m in reversed(morceaux) if m.get("usage")), None)
    if not usage:
        echecs.append("flux (usage absent)")
        step(f"flux → {len(morceaux)} morceaux, aucun ne donne l'usage → échec")
        return
    attendu = cout_attendu(usage, cache_cost)
    enregistree = attendre_depense(token_id, avant + attendu) - avant
    conforme = proche(enregistree, attendu)
    step(f"flux → {len(morceaux)} morceaux ; jetons : {usage.get('prompt_tokens')} entrée + {usage.get('completion_tokens')} sortie ; "
         f"dépense enregistrée : {enregistree:.10f} ; attendue au tarif du modèle : {attendu:.10f} → {'conforme' if conforme else 'échec'}")
    if not conforme:
        echecs.append("flux (dépense)")


def controle_recherche(test_key, token_id, echecs):
    """Recherche sans profondeur demandée, avec des options sans profondeur (la profondeur de la déclaration, appliquée par
    la garde), puis « high » : coût calculé et dépense enregistrée au prix déclaré ; coût facturé par OpenRouter, converti
    comme les prix déclarés, à 2 % près (il dit si la profondeur a été transmise)."""
    question = [{"role": "user", "content": "Quelle est la capitale de la Slovénie ? Réponds en une phrase."}]
    for libelle, profondeur, extra in (("sans profondeur", profondeur_recherche, {}),
                                       ("options sans profondeur", profondeur_recherche, {"web_search_options": {}}),
                                       ("high", "high", {"web_search_options": {"search_context_size": "high"}})):
        avant = depense(token_id)
        st, rep, hdr = call("POST", "/v1/chat/completions", {"model": MODEL, "messages": question, "max_tokens": 100, **extra}, key=test_key)
        if st != 200:
            echecs.append(f"recherche {libelle} (requête refusée)")
            step(f"recherche {libelle} → HTTP {st} ; {json.dumps(rep, ensure_ascii=False)[:300]}")
            continue
        usage = rep.get("usage") or {}
        attendu = cout_attendu(usage, cache_cost, profondeur)
        calcule = float(hdr.get("x-litellm-response-cost") or 0)
        enregistree = attendre_depense(token_id, avant + attendu) - avant
        # Coût en dollars qu'OpenRouter renvoie dans l'usage de la réponse : absent, il n'est pas comparé.
        facture = None if usage.get("cost") is None else usage["cost"] * (1 + (mi.get("frais_openrouter") or 0)) * (mi.get("fx_rate_usd_eur") or 0)
        conforme = proche(calcule, attendu) and proche(enregistree, attendu) and (facture is None or abs(facture - attendu) <= 0.02 * attendu)
        step(f"recherche {libelle} ({profondeur}) → {len(citations(rep))} sources citées ; coût calculé : {calcule:.10f}, dépense enregistrée : "
             f"{enregistree:.10f} ; attendus : {attendu:.10f} ; facturé par OpenRouter : {'non renvoyé' if facture is None else f'{facture:.10f}'} "
             f"→ {'conforme' if conforme else 'échec'}")
        if not conforme:
            echecs.append(f"recherche {libelle} (coût)")


st, info, _ = call("GET", "/model/info")
deployments = [m for m in (info or {}).get("data", []) if m.get("model_name") == MODEL]
if not deployments:
    sys.exit(f"modèle {MODEL} introuvable dans /model/info (HTTP {st})")
mi = deployments[0].get("model_info") or {}
in_cost, out_cost = mi.get("input_cost_per_token"), mi.get("output_cost_per_token")
cache_cost = mi.get("cache_read_input_token_cost")
# Recherche sur le web facturée à chaque requête : prix par profondeur ; profondeur par défaut de la déclaration, que la
# garde applique aux requêtes qui n'en demandent pas (la profondeur moyenne, sans déclaration).
lp = deployments[0].get("litellm_params") or {}
prix_recherche = lp.get("search_context_cost_per_query") or {}
profondeur_recherche = (lp.get("web_search_options") or {}).get("search_context_size", "medium")
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
    ids = [m["id"] for m in (models or {}).get("data", [])]
    step(f"critère 1 — /v1/models avec la clé de test → HTTP {st}, modèles : {ids}")
    if st != 200 or MODEL not in ids:
        echecs.append("critère 1 (/v1/models)")

    if mi.get("type_api") == "embeddings":
        controle_embeddings(test_key, token_id, echecs)
    elif mi.get("type_api") == "decision":
        controle_decision(test_key, token_id, echecs)
    else:
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
        if st == 200 and citations(comp) and not prix_recherche:
            echecs.append("recherche (prix non déclaré)")
            step("recherche — échec : la réponse cite des sources du web, sans prix de recherche déclaré (recherche_usd)")
        if in_cost is None or out_cost is None:
            step("flux — non vérifié : tarifs du modèle absents")
        else:
            controle_flux(test_key, token_id, echecs)
        if prix_recherche:
            controle_recherche(test_key, token_id, echecs)

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
            enregistree = attendre_depense(token_id, total)
            enregistre = proche(enregistree, total)
            step(f"cache — dépense enregistrée sur la clé : {enregistree:.10f} ; attendue : {total:.10f} → {'conforme' if enregistre else 'échec'}")
            if not (calcule and enregistre):
                echecs.append("cache (coût)")

        # Format Anthropic, utilisé par des assistants de code : LiteLLM le traduit selon la route du modèle (2026-09-26 :
        # la route openai/… de Qwen3.8 passait par l'API Responses, refusée par OVH, alors que chat/completions répondait).
        message = {"model": MODEL, "messages": [{"role": "user", "content": "Réponds uniquement par le mot OK."}], "max_tokens": 300}
        if prix_recherche:
            # Modèle qui cherche sur le web : par /v1/messages et /v1/responses, LiteLLM ne compte pas sa recherche ; la garde
            # refuse ces API pour lui, avant tout appel payant.
            for chemin, corps in (("/v1/messages", message), ("/v1/responses", {"model": MODEL, "input": "Réponds uniquement par le mot OK."})):
                st, rep, _ = call("POST", chemin, corps, key=test_key)
                refuse = st == 400 and "API refusée" in json.dumps(rep, ensure_ascii=False)
                step(f"{chemin} → HTTP {st} ; {'refusé par la garde' if refuse else json.dumps(rep, ensure_ascii=False)[:300]} → {'conforme' if refuse else 'échec'}")
                if not refuse:
                    echecs.append(f"recherche ({chemin} accepté)")
        else:
            avant_message = depense(token_id)
            st, msg, hdr = call("POST", "/v1/messages", message, key=test_key)
            texte = [b.get("text") for b in (msg or {}).get("content", []) if b.get("type") == "text"] if st == 200 else None
            step(f"/v1/messages (format Anthropic) → HTTP {st} ; " + (f"réponse : {str(texte)[:60]}" if st == 200 else f"erreur : {json.dumps(msg, ensure_ascii=False)[:300]}"))
            if st == 200 and in_cost and out_cost:
                # La dépense de cet appel s'écrit en différé : l'attendre, pour ne pas la prendre pour celle du flux.
                attendre_depense(token_id, avant_message + float(hdr.get("x-litellm-response-cost") or 0))
            controle_claude_code(test_key, token_id, echecs)
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
        if st != 401:
            echecs.append("critère 7 (clé révoquée encore acceptée)")
    st, _, _ = call("POST", "/team/delete", {"team_ids": [team_id]})
    step(f"POST /team/delete → HTTP {st}")

if echecs:
    sys.exit(f"échec : {', '.join(echecs)}")
