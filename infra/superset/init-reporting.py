"""Déclare dans Superset la base « LiteLLM reporting » (rôle reporting_ro) et un jeu de données par
vue du schéma reporting. Idempotent. Le mot de passe arrive par la première ligne de l'entrée
standard (variable pw définie par l'appelant) : il n'apparaît ni à l'écran ni dans ps.

  cd /opt/linagora-ia && { grep ^REPORTING_RO_PASSWORD= .env | cut -d= -f2-; cat superset/init-reporting.py; } \
    | docker compose exec -T superset python3 -c "import sys; pw = sys.stdin.readline().strip(); exec(sys.stdin.read())"
"""
from sqlalchemy import text

from superset.app import create_app

VIEWS = ["v_requests", "v_daily_user", "v_daily_team", "v_keys", "v_teams", "v_users", "v_models", "v_check_pricing_eur"]

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
