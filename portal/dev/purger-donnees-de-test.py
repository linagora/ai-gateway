#!/usr/bin/env python3
"""Purge, en DEV seulement, des données laissées par les tests (parcours Playwright et tests de contrat).

Sans option, le script compte ce qu'il supprimerait ; avec --appliquer, il supprime :
  - dans le LiteLLM de dev : les équipes de test (avec leurs clés), les clés et l'appartenance des utilisateurs de test
    aux équipes de démonstration (« R&D », « LPS Paris »), puis ces utilisateurs ;
  - dans la base portal de dev, qui ne sert qu'aux tests : les prélèvements, les abonnements, les demandes, le journal
    d'audit, les responsables d'équipe, les alertes de budget, les offres d'abonnement de test, les intégrations de
    test avec leurs clés publiques, les nouveautés de test avec leurs accusés de lecture, et les textes anglais des
    modèles de démonstration (`dev-*`), que les captures du README y laissent et que les parcours supposent absents
    (le catalogue, les offres initiales, les réglages et l'intégration « demo » restent) ;
  - dans Mailpit : les courriels reçus.

Utilisateurs, équipes, offres et intégrations de test : identifiant ou nom terminé par un suffixe de 8 caractères
(« equipes-membre-muhwx8w6 », « u-1a2b3c4d », « Équipe budget muhyljri », « Offre suivi mui8dueh », « e2e-mujm3qqf »).
Les équipes et les utilisateurs sans ce suffixe (admin des tests, lecteur, utilisateur technique de LiteLLM) restent.

  python3 dev/purger-donnees-de-test.py [--appliquer]
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

LITELLM = os.environ.get("LITELLM_BASE_URL", "http://127.0.0.1:54400/admin")
CLE_MAITRE = os.environ.get("LITELLM_MASTER_KEY", "sk-dev-master-key")
MAILPIT = os.environ.get("MAILPIT_URL", "http://127.0.0.1:54825")
COMPOSE = Path(__file__).resolve().parent / "docker-compose.yml"

SUFFIXE_DE_TEST = re.compile(r"[- ][a-z0-9]{8}$")
EQUIPES_DE_DEMONSTRATION = {"R&D", "LPS Paris"}
# Dans l'ordre des suppressions : un prélèvement tient à son abonnement, un abonnement à sa demande.
TABLES_DE_TEST = ["SubscriptionCharge", "Subscription", "AccessRequest", "AuditLog", "TeamManager", "TeamBudgetAlert"]
OFFRES_DE_TEST = """from "SubscriptionOffer" where name ~ '[- ][a-z0-9]{8}$'"""
# Une clé publique tient à son intégration : elle est supprimée d'abord.
CLES_D_INTEGRATION_DE_TEST = """from "IntegrationKey" where "integrationId" ~ '[- ][a-z0-9]{8}$'"""
INTEGRATIONS_DE_TEST = """from "Integration" where id ~ '[- ][a-z0-9]{8}$'"""
# Nouveautés des parcours (titre terminé par le suffixe de test), avec leurs accusés de lecture (supprimés avec elles),
# et accusés de lecture des utilisateurs de test sur les autres nouveautés.
NOUVEAUTES_DE_TEST = """from "NewsItem" where "titleFr" ~ '[- ][a-z0-9]{8}$'"""
LECTURES_DE_TEST = """from "NewsReceipt" where uid ~ '[- ][a-z0-9]{8}$'"""
# Textes anglais des modèles de démonstration, laissés par les captures du README : les parcours qui en ont besoin les
# écrivent eux-mêmes.
MODELES_TRADUITS = """from "CatalogEntry" where "modelName" like 'dev-%' and coalesce("displayNameEn", "shortDescriptionEn", "longDescriptionEn", "limitationsEn") is not null"""
SANS_TEXTES_ANGLAIS = """update "CatalogEntry" set "displayNameEn" = null, "shortDescriptionEn" = null, "longDescriptionEn" = null, "limitationsEn" = null where "modelName" like 'dev-%'"""


def litellm(methode: str, chemin: str, corps: object | None = None) -> object:
    requete = urllib.request.Request(
        f"{LITELLM}{chemin}",
        method=methode,
        data=None if corps is None else json.dumps(corps).encode(),
        headers={"Authorization": f"Bearer {CLE_MAITRE}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(requete, timeout=120) as reponse:
        return json.load(reponse)


def portal(sql: str) -> str:
    commande = ["docker", "compose", "-f", str(COMPOSE), "exec", "-T", "postgres", "sh", "-c", 'psql -U "${POSTGRES_USER:-postgres}" -d portal -v ON_ERROR_STOP=1 -Atc "$0"', sql]
    return subprocess.run(commande, check=True, capture_output=True, text=True).stdout.strip()


def par_lots(elements: list, taille: int):
    for i in range(0, len(elements), taille):
        yield elements[i : i + taille]


def utilisateurs() -> list[str]:
    ids, page = [], 1
    while True:
        donnees = litellm("GET", f"/user/list?page={page}&page_size=100")
        ids += [u["user_id"] for u in donnees["users"]]
        if page >= donnees["total_pages"]:
            return ids
        page += 1


def main() -> None:
    appliquer = "--appliquer" in sys.argv[1:]
    de_test = lambda identifiant: bool(identifiant) and SUFFIXE_DE_TEST.search(identifiant) is not None

    equipes = litellm("GET", "/team/list")
    equipes_de_test = [e for e in equipes if e.get("team_alias") not in EQUIPES_DE_DEMONSTRATION and de_test(e.get("team_alias"))]
    gardees = [e for e in equipes if e not in equipes_de_test]
    cles = [c["token"] for e in gardees for c in (e.get("keys") or []) if de_test(c.get("user_id"))]
    membres = [(e["team_id"], m["user_id"]) for e in gardees for m in (e.get("members_with_roles") or []) if de_test(m.get("user_id"))]
    comptes = [u for u in utilisateurs() if de_test(u)]
    lignes = {table: int(portal(f'select count(*) from "{table}"')) for table in TABLES_DE_TEST}
    offres = int(portal(f"select count(*) {OFFRES_DE_TEST}"))
    integrations = int(portal(f"select count(*) {INTEGRATIONS_DE_TEST}"))
    nouveautes = int(portal(f"select count(*) {NOUVEAUTES_DE_TEST}"))
    lectures = int(portal(f"select count(*) {LECTURES_DE_TEST}"))
    traduits = int(portal(f"select count(*) {MODELES_TRADUITS}"))
    courriels = total_courriels_mailpit()

    print(f"LiteLLM : {len(equipes_de_test)} équipes de test sur {len(equipes)} (gardées : {', '.join(sorted(e.get('team_alias') or e['team_id'] for e in gardees))})")
    print(f"LiteLLM : {len(cles)} clés et {len(membres)} appartenances d'utilisateurs de test dans les équipes gardées ; {len(comptes)} utilisateurs de test")
    print("portal : " + ", ".join(f"{table} {n}" for table, n in lignes.items()) + f", offres de test {offres}, intégrations de test {integrations}, nouveautés de test {nouveautes}, lectures de test {lectures}, modèles de démonstration traduits {traduits}")
    print(f"Mailpit : {courriels} courriels")
    if not appliquer:
        print("Simulation : rien n'est supprimé (relancer avec --appliquer).")
        return

    for lot in par_lots([e["team_id"] for e in equipes_de_test], 50):
        litellm("POST", "/team/delete", {"team_ids": lot})
    for lot in par_lots(cles, 50):
        litellm("POST", "/key/delete", {"keys": lot})
    for team_id, user_id in membres:
        litellm("POST", "/team/member_delete", {"team_id": team_id, "user_id": user_id})
    for lot in par_lots(comptes, 100):
        litellm("POST", "/user/delete", {"user_ids": lot})
    portal("; ".join([*(f'delete from "{table}"' for table in TABLES_DE_TEST), f"delete {OFFRES_DE_TEST}", f"delete {CLES_D_INTEGRATION_DE_TEST}", f"delete {INTEGRATIONS_DE_TEST}", f"delete {LECTURES_DE_TEST}", f"delete {NOUVEAUTES_DE_TEST}", SANS_TEXTES_ANGLAIS]))
    with urllib.request.urlopen(urllib.request.Request(f"{MAILPIT}/api/v1/messages", method="DELETE"), timeout=60):
        pass
    print("Purge appliquée.")


def total_courriels_mailpit() -> int:
    with urllib.request.urlopen(f"{MAILPIT}/api/v1/messages?limit=1", timeout=30) as reponse:
        return int(json.load(reponse).get("total", 0))


if __name__ == "__main__":
    main()
