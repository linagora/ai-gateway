#!/usr/bin/env bash
# Reporting des abonnements (spécification #51, ticket #60, ADR 0002) : lien entre la base litellm et le schéma de
# reporting de la base portal. Idempotent ; à relancer après une migration du portail qui touche ses vues de reporting.
#   1. génère PORTAL_REPORTING_RO_PASSWORD dans .env s'il manque (jamais affiché) ;
#   2. crée ou met à jour le rôle portal_reporting_ro : connexion à la base portal, lecture seule, schéma reporting ;
#   3. vues de reporting du portail (postgres/portal_reporting_views.sql, en tant que portal) ;
#   4. extension postgres_fdw, serveur « portail » et correspondance d'utilisateur pour litellm (en superutilisateur) ;
#   5. tables étrangères et vues des abonnements du schéma reporting de litellm (postgres/reporting_abonnements.sql) ;
#   6. contrôles : lecture des vues par reporting_ro, refus des tables étrangères et des tables brutes du portail.
# Les mots de passe passent par l'entrée standard de psql : ni à l'écran, ni dans ps.
#
#   ssh ia-host 'cd /opt/linagora-ia && sudo scripts/installer-lien-portail.sh'
set -euo pipefail
cd "$(dirname "$0")/.."

# Commande d'accès au PostgreSQL de la plateforme (remplaçable pour un essai sur un conteneur jetable).
POSTGRES_EXEC="${POSTGRES_EXEC:-docker compose exec -T postgres}"
psql_() { $POSTGRES_EXEC psql -v ON_ERROR_STOP=1 -q -X "$@"; }

# 1. Mot de passe du rôle en lecture seule
grep -q '^PORTAL_REPORTING_RO_PASSWORD=' .env || echo 'PORTAL_REPORTING_RO_PASSWORD=__GENERATE__' >> .env
scripts/gen-secrets.sh > /dev/null
pw="$(grep '^PORTAL_REPORTING_RO_PASSWORD=' .env | cut -d= -f2-)"
[[ "$pw" =~ ^[0-9a-f]{64}$ ]] || { echo "PORTAL_REPORTING_RO_PASSWORD absent ou inattendu dans .env" >&2; exit 1; }

# 2. Rôle en lecture seule (VERBOSITY terse : une erreur n'affiche pas l'instruction, donc pas le mot de passe)
{ printf '\\set VERBOSITY terse\n\\set pw %s\n' "$pw"; cat <<'SQL'
SELECT format('CREATE ROLE portal_reporting_ro LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'portal_reporting_ro') \gexec
ALTER ROLE portal_reporting_ro WITH LOGIN PASSWORD :'pw';
ALTER ROLE portal_reporting_ro SET default_transaction_read_only = on;
ALTER ROLE portal_reporting_ro SET search_path = reporting;
GRANT CONNECT ON DATABASE portal TO portal_reporting_ro;
SQL
} | psql_ -U postgres -d postgres
echo "• rôle portal_reporting_ro : lecture seule, base portal"

# 3. Vues de reporting du portail
psql_ -U portal -d portal -f - < postgres/portal_reporting_views.sql
echo "• vues de reporting du portail : $(psql_ -U portal_reporting_ro -d portal -At -c 'select count(*) from v_subscriptions') abonnements"

# 4. Lien entre bases : connexion TCP au service postgres, authentifiée par mot de passe (scram), jamais « trust »
{ printf '\\set VERBOSITY terse\n\\set pw %s\n' "$pw"; cat <<'SQL'
CREATE EXTENSION IF NOT EXISTS postgres_fdw;
SELECT 'CREATE SERVER portail FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host ''postgres'', port ''5432'', dbname ''portal'')'
WHERE NOT EXISTS (SELECT FROM pg_foreign_server WHERE srvname = 'portail') \gexec
GRANT USAGE ON FOREIGN SERVER portail TO litellm;
SELECT format('CREATE USER MAPPING FOR litellm SERVER portail OPTIONS (user %L, password %L)', 'portal_reporting_ro', :'pw')
WHERE NOT EXISTS (SELECT FROM pg_user_mappings WHERE srvname = 'portail' AND usename = 'litellm') \gexec
ALTER USER MAPPING FOR litellm SERVER portail OPTIONS (SET password :'pw');
SQL
} | psql_ -U postgres -d litellm
echo "• lien entre bases « portail » : litellm lit le schéma reporting du portail"

# 5. Vues des abonnements dans le schéma reporting de litellm
psql_ -U litellm -d litellm -f - < postgres/reporting_abonnements.sql
echo "• vues des abonnements du reporting : $(psql_ -U reporting_ro -d litellm -At -c 'select count(*) from v_team_subscriptions') lignes par équipe et par offre"

# 6. Contrôles d'accès : chaque lecture interdite doit être refusée
refuse() {
  if psql_ "$@" > /dev/null 2>&1; then echo "ÉCHEC : lecture autorisée ($*)" >&2; exit 1; fi
}
refuse -U reporting_ro -d litellm -c 'select 1 from portail.v_subscriptions limit 1'
refuse -U portal_reporting_ro -d portal -c 'select 1 from public."Subscription" limit 1'
refuse -U portal_reporting_ro -d portal -c 'create table reporting.essai (x int)'
echo "• contrôles : tables étrangères et tables brutes du portail refusées, écriture refusée"
