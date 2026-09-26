"""Déclare dans Superset la base « LiteLLM reporting » (rôle reporting_ro) et un jeu de données par
vue du schéma reporting. Idempotent. Le mot de passe arrive par la première ligne de l'entrée
standard (variable pw définie par l'appelant) : il n'apparaît ni à l'écran ni dans ps.

  cd /opt/linagora-ia && { grep ^REPORTING_RO_PASSWORD= .env | cut -d= -f2-; cat superset/init-reporting.py; } \
    | docker compose exec -T superset python3 -c "import sys; pw = sys.stdin.readline().strip(); exec(sys.stdin.read())"
"""
from sqlalchemy import text

from superset.app import create_app

VIEWS = ["v_requests", "v_daily_user", "v_daily_team", "v_keys", "v_teams", "v_users", "v_models", "v_check_pricing_eur",
         "v_usage_daily", "v_team_budget", "v_activity", "v_key_status",
         # Abonnements (postgres/reporting_abonnements.sql, après scripts/installer-lien-portail.sh)
         "v_subscriptions", "v_team_subscriptions", "v_team_monthly_cost", "v_user_monthly_cost"]
# Seules vues ouvertes aux lecteurs du reporting : agrégées, sans donnée par personne ni par clé.
READER_VIEWS = ["v_usage_daily", "v_team_budget", "v_activity", "v_team_subscriptions", "v_team_monthly_cost"]

app = create_app()
with app.app_context():
    from superset import db
    from superset.connectors.sqla.models import SqlaTable
    from superset.models.core import Database

    name = "LiteLLM reporting"
    database = db.session.query(Database).filter_by(database_name=name).one_or_none()
    if database is None:
        database = Database(database_name=name, expose_in_sqllab=True)
        db.session.add(database)
    database.set_sqlalchemy_uri(f"postgresql+psycopg2://reporting_ro:{pw}@postgres:5432/litellm")  # noqa: F821
    db.session.commit()
    with database.get_sqla_engine() as engine, engine.connect() as conn:
        print(f"• connexion « {name} » : OK ({conn.execute(text('select count(*) from reporting.v_requests')).scalar()} requêtes)")

    for view in VIEWS:
        ds = db.session.query(SqlaTable).filter_by(table_name=view, schema="reporting", database_id=database.id).one_or_none()
        created = ds is None
        if created:
            ds = SqlaTable(table_name=view, schema="reporting", database=database)
            db.session.add(ds)
            db.session.flush()
        ds.fetch_metadata()
        print(f"• jeu de données reporting.{view} : {'créé' if created else 'mis à jour'} ({len(ds.columns)} colonnes)")
    db.session.commit()

    # Rôle des lecteurs du reporting (PORTAL_REPORTING_UIDS) : droits de lecture de Gamma + accès aux
    # seules vues agrégées. Les vues nominatives (requêtes, utilisateurs, clés) restent réservées aux admins.
    from superset import security_manager as sm

    reader = sm.find_role("Lecteur reporting") or sm.add_role("Lecteur reporting")
    permissions = set(sm.find_role("Gamma").permissions)
    for ds in db.session.query(SqlaTable).filter_by(schema="reporting", database_id=database.id):
        if ds.table_name in READER_VIEWS:
            permissions.add(sm.add_permission_view_menu("datasource_access", ds.get_perm()))
    reader.permissions = list(permissions)
    db.session.commit()
    print(f"• rôle « Lecteur reporting » : {len(permissions)} permissions")
