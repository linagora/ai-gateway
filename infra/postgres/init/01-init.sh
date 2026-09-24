#!/usr/bin/env bash
# Exécuté UNE SEULE FOIS par l'image postgres, au premier démarrage (volume vide).
# Crée les bases et rôles applicatifs. Les vues de reporting sont créées plus tard
# (reporting_views.sql), une fois que LiteLLM a créé ses tables.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE ROLE litellm  LOGIN PASSWORD '${LITELLM_DB_PASSWORD}';
	CREATE ROLE portal   LOGIN PASSWORD '${PORTAL_DB_PASSWORD}';
	CREATE ROLE superset LOGIN PASSWORD '${SUPERSET_DB_PASSWORD}';
	CREATE ROLE reporting_ro LOGIN PASSWORD '${REPORTING_RO_PASSWORD}';

	CREATE DATABASE litellm  OWNER litellm;
	CREATE DATABASE portal   OWNER portal;
	CREATE DATABASE superset OWNER superset;

	REVOKE ALL ON DATABASE litellm  FROM PUBLIC;
	REVOKE ALL ON DATABASE portal   FROM PUBLIC;
	REVOKE ALL ON DATABASE superset FROM PUBLIC;
	GRANT CONNECT ON DATABASE litellm TO reporting_ro;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname litellm <<-EOSQL
	CREATE SCHEMA IF NOT EXISTS reporting AUTHORIZATION litellm;
	GRANT USAGE ON SCHEMA reporting TO reporting_ro;
	ALTER DEFAULT PRIVILEGES FOR ROLE litellm IN SCHEMA reporting GRANT SELECT ON TABLES TO reporting_ro;
	ALTER ROLE reporting_ro SET search_path = reporting;
	ALTER ROLE reporting_ro SET default_transaction_read_only = on;
EOSQL
