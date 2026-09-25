"""Recette de la liste blanche OpenRouter, de la garde et de JEV. Crée une équipe et trois clés de test,
supprimées à la fin. Coût : un appel au modèle testé et un appel à JEV (moins de 0,01 €).

  cd /opt/linagora-ia && docker compose exec -T litellm python3 - [modèle] < scripts/test-liste-blanche.py

Le modèle testé (par défaut ministral-3b, le moins cher de la liste) doit figurer dans la liste blanche.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

import yaml

PROXY = "http://localhost:4000/admin"
LISTE = "/app/passerelle/liste-blanche-openrouter.yaml"
MODELE = sys.argv[1] if len(sys.argv) > 1 else "ministral-3b"
JEV = "jev-latest"
MAITRE = os.environ["LITELLM_MASTER_KEY"]
echecs = []


def http(methode, chemin, corps=None, cle=MAITRE):
    req = urllib.request.Request(PROXY + chemin, method=methode, data=json.dumps(corps).encode() if corps is not None else None,
                                 headers={"Authorization": f"Bearer {cle}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        brut = e.read()
        try:
            return e.code, json.loads(brut or b"{}")
        except ValueError:
            return e.code, {"brut": brut[:300].decode(errors="replace")}


def controle(libelle, ok, detail=""):
    print(f"{'✔' if ok else '✘'} {libelle}{'' if ok else f' — {detail}'}")
    if not ok:
        echecs.append(libelle)


def conversation(cle, modele=MODELE, contenu="Réponds : bonjour", **extra):
    return http("POST", "/v1/chat/completions", {"model": modele, "max_tokens": 8, "messages": [{"role": "user", "content": contenu}], **extra}, cle)


def depense(cle):
    return http("GET", f"/key/info?key={cle['key']}")[1]["info"]["spend"]


cfg = yaml.safe_load(open(LISTE))
liste = {e["nom"]: e for e in cfg["modeles"]}
assert MODELE in liste, f"{MODELE} n'est pas dans la liste blanche"

# 1. Déclarations
modeles = http("GET", "/model/info")[1]["data"]
tarifs = {m["model_name"]: m["litellm_params"] for m in modeles}
openrouter = {m["model_name"]: m for m in modeles if "openrouter" in json.dumps(m.get("litellm_params") or {})}
controle("aucun joker déclaré", not [m["model_name"] for m in modeles if "*" in m["model_name"] or "*" in str((m.get("litellm_params") or {}).get("model"))])
controle("les modèles OpenRouter déclarés sont exactement ceux de la liste blanche", set(openrouter) == set(liste),
         f"hors liste : {sorted(set(openrouter) - set(liste))} ; manquants : {sorted(set(liste) - set(openrouter))}")
for nom, m in sorted(openrouter.items()):
    p = (m.get("litellm_params") or {}).get("provider") or {}
    zone = cfg["zones"].get((liste.get(nom) or {}).get("zone"), [])
    controle(f"{nom} : servi uniquement dans sa zone, sans repli", bool(p.get("only")) and set(p["only"]) <= set(zone) and p.get("allow_fallbacks") is False, json.dumps(p))

# 2. Équipe et clés de test : sans restriction de modèle, N1 limitée au modèle testé, Expérimental limitée à JEV
_, equipe = http("POST", "/team/new", {"team_alias": "recette-liste-blanche"})
cles = []
try:
    for alias, extra in [("recette-liste-blanche", {}), ("recette-n1", {"models": [MODELE], "metadata": {"data_level": "N1"}}),
                         ("recette-jev", {"models": [JEV], "metadata": {"data_level": "EXP"}})]:
        s, cle = http("POST", "/key/generate", {"team_id": equipe["team_id"], "key_alias": alias, **extra})
        assert s == 200, f"création de la clé {alias} : HTTP {s} {json.dumps(cle)[:300]}"
        cles.append(cle)
    cle, cle_n1, cle_jev = cles
    time.sleep(2)

    # 3. Modèle de la liste
    s, rep = conversation(cle_n1["key"])
    controle(f"{MODELE} (liste blanche) répond", s == 200, json.dumps(rep)[:300])
    usage = rep.get("usage") or {}

    # 4. Modèles hors liste, même pour une clé sans restriction de modèle
    for nom in ["openrouter/openai/gpt-4o-mini", "openrouter/anthropic/claude-3.5-haiku", "openai/gpt-4o-mini", "anthropic/claude-3-5-haiku", liste[MODELE]["openrouter"]]:
        s, rep = conversation(cle["key"], nom)
        controle(f"modèle hors liste refusé : {nom}", s in (400, 401, 403, 404), f"HTTP {s}")

    # 5. Paramètres qui changeraient de modèle ou de fournisseur (refusés avant tout appel payant)
    for param, valeur in {"models": ["openai/gpt-4o-mini"], "route": "fallback", "provider": {"only": ["openai"]}, "plugins": [{"id": "web"}],
                          "preset": "essai", "usage": {"include": True}, "extra_body": {"models": ["openai/gpt-4o-mini"]},
                          "fallbacks": [JEV], "additional_drop_params": ["provider"]}.items():
        s, rep = conversation(cle["key"], **{param: valeur})
        controle(f"paramètre « {param} » refusé", s == 400 and "Paramètre refusé" in json.dumps(rep, ensure_ascii=False), f"HTTP {s} {json.dumps(rep, ensure_ascii=False)[:200]}")

    # 6. JEV : modèle de la passerelle, réservé aux clés qui le portent
    question = json.dumps({"state": "Mes virements échouent depuis trois jours, c'est bloquant.",
                           "questions": {"urgent": {"type": "noul", "instructions": "Le message exprime-t-il une urgence ?"}}}, ensure_ascii=False)
    s, rep = conversation(cle_jev["key"], JEV, question)
    reponses = json.loads(rep["choices"][0]["message"]["content"]).get("answers") or {} if s == 200 else {}
    controle("JEV répond à une clé Expérimental qui le porte", s == 200 and "urgent" in reponses, f"HTTP {s} {json.dumps(rep, ensure_ascii=False)[:300]}")
    usage_jev = rep.get("usage") or {}
    s, rep = conversation(cle_n1["key"], JEV, question)
    controle("JEV refusé à une clé qui ne le porte pas", s in (401, 403), f"HTTP {s}")
    s, rep = conversation(cle_jev["key"], JEV, "bonjour")
    controle("JEV explique le format attendu", s == 400 and "System One" in json.dumps(rep, ensure_ascii=False), f"HTTP {s} {json.dumps(rep, ensure_ascii=False)[:200]}")

    # 7. Coûts enregistrés en euros, au tarif déclaré (et non au coût en dollars renvoyé par OpenRouter)
    time.sleep(25)
    for nom, c, u in [(MODELE, cle_n1, usage), (JEV, cle_jev, usage_jev)]:
        t = tarifs[nom]
        attendu = u.get("prompt_tokens", 0) * t["input_cost_per_token"] + u.get("completion_tokens", 0) * t["output_cost_per_token"]
        d = depense(c)
        controle(f"{nom} : coût enregistré au tarif en euros", attendu > 0 and abs(d - attendu) <= attendu * 0.01, f"attendu {attendu:.3g} €, enregistré {d:.3g}")
finally:
    if cles:
        http("POST", "/key/delete", {"keys": [c["key"] for c in cles]})
    http("POST", "/team/delete", {"team_ids": [equipe["team_id"]]})
    print("\nnettoyage : clés et équipe de test supprimées")

print(f"{len(echecs)} échec(s)" if echecs else "tous les contrôles passent")
sys.exit(1 if echecs else 0)
