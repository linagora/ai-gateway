"""Crée ou met à jour les tableaux de bord « Consommation » (admins et lecteurs du reporting), « Pilotage »
et « Par salarié » (admins) : libellés et métriques des jeux de données, graphiques, disposition, filtres,
droits ; les abonnements y figurent, en € TTC, à côté de la passerelle, en € HT. Idempotent (identifiants
stables). À lancer après superset/init-reporting.py :

  cd /opt/linagora-ia && docker compose exec -T superset python3 - < superset/tableaux-de-bord.py
"""
import json
import uuid

from superset.app import create_app

ESPACE = uuid.UUID("5b0f6e0e-2f1d-4c52-9a55-6c6e61676f72")  # espace de noms des identifiants de la passerelle
PERIODE = 'DATEADD(DATETIME("today"), -29, day) : DATEADD(DATETIME("today"), 1, day)'  # 30 jours, aujourd'hui compris
TEMPS = {"v_usage_daily": "day", "v_daily_user": "day", "v_requests": "started_at", "v_check_pricing_eur": "day"}
# Coûts mensuels (abonnements et passerelle) : colonne de temps au mois, hors du filtre de période des tableaux, sur les
# douze derniers mois.
MOIS = {"v_team_monthly_cost": "month", "v_user_monthly_cost": "month"}
# Jeux de données qui ont une colonne « team » : le filtre Équipe de « Consommation » s'applique à leurs graphiques.
JEUX_PAR_EQUIPE = {"v_usage_daily", "v_team_budget", "v_team_subscriptions", "v_team_monthly_cost"}
EUROS, NOMBRE, POURCENT, MS = "$,.2f", ",d", ".1%", ",.0f"

LIBELLES = {
    "v_usage_daily": {"day": "Jour", "team": "Équipe", "model_name": "Modèle", "provider": "Fournisseur",
                      "key_level": "Niveau déclaré de la clé", "hosting": "Hébergement"},
    "v_team_budget": {"team": "Équipe", "max_budget": "Budget (€)", "budget_duration": "Période du budget",
                      "budget_reset_at": "Remise à zéro", "spend": "Dépense de la période (€)", "budget_used": "Budget consommé"},
    "v_activity": {"window_days": "Fenêtre (jours)", "active_teams": "Équipes actives", "active_keys": "Clés actives"},
    "v_key_status": {"key_alias": "Clé", "user_id": "Uid", "user_email": "Courriel", "team": "Équipe", "key_level": "Niveau déclaré",
                     "max_budget": "Budget (€)", "budget_duration": "Période du budget", "budget_reset_at": "Remise à zéro",
                     "spend": "Dépense (€)", "budget_used": "Budget consommé", "expires": "Expiration", "created_at": "Création",
                     "last_used": "Dernière utilisation", "days_inactive": "Jours sans utilisation", "status": "Statut"},
    "v_daily_user": {"day": "Jour", "user_id": "Uid", "user_email": "Courriel", "key_alias": "Clé", "team_alias": "Équipe",
                     "key_data_level": "Niveau déclaré", "model_name": "Modèle", "provider": "Fournisseur",
                     "key_level": "Niveau déclaré de la clé"},
    "v_requests": {"started_at": "Début", "model_name": "Modèle", "provider": "Fournisseur", "status": "Statut", "team_alias": "Équipe"},
    "v_check_pricing_eur": {"day": "Jour", "model_name": "Modèle", "provider": "Fournisseur", "requests": "Requêtes",
                            "spend_unreliable": "Dépense (non fiable)"},
    "v_models": {"model_name": "Modèle", "fournisseur": "Fournisseur", "pricing_currency": "Devise du tarif", "data_level": "Niveau",
                 "hosting": "Hébergement"},
    "v_subscriptions": {"user_id": "Uid", "user_email": "Courriel", "team": "Équipe", "supplier": "Fournisseur", "offer": "Offre",
                        "offer_label": "Offre", "monthly_amount_eur": "Montant mensuel (€ TTC)", "subscribed_on": "Souscrit le",
                        "expires_on": "Échéance", "terminated_on": "Résilié le", "status": "Statut",
                        "account_outside_linagora": "Adresse hors LINAGORA"},
    "v_team_subscriptions": {"team": "Équipe", "supplier": "Fournisseur", "offer": "Offre", "active_subscriptions": "Abonnements en cours",
                             "monthly_cost_ttc": "Coût mensuel (€ TTC)"},
    "v_team_monthly_cost": {"month": "Mois", "team": "Équipe", "gateway_cost_ht": "Passerelle (€ HT)",
                            "subscriptions_cost_ttc": "Abonnements (€ TTC)", "total_cost": "Total (€)"},
    "v_user_monthly_cost": {"month": "Mois", "user_id": "Uid", "gateway_cost_ht": "Passerelle (€ HT)",
                            "subscriptions_cost_ttc": "Abonnements (€ TTC)", "total_cost": "Total (€)"},
}
COUTS_MENSUELS = [
    ("passerelle", "SUM(gateway_cost_ht)", "Passerelle (€ HT)", EUROS),
    ("abonnements", "SUM(subscriptions_cost_ttc)", "Abonnements (€ TTC)", EUROS),
    ("total", "SUM(total_cost)", "Total (€, passerelle HT et abonnements TTC)", EUROS),
]
METRIQUES = {
    "v_usage_daily": [
        ("cout", "SUM(spend)", "Coût (€)", EUROS),
        ("requetes", "SUM(requests)", "Requêtes", NOMBRE),
        ("reussies", "SUM(successful_requests)", "Réussies", NOMBRE),
        ("echecs", "SUM(failed_requests)", "En échec", NOMBRE),
        ("taux_reussite", "SUM(successful_requests)::float / NULLIF(SUM(requests), 0)", "Taux de réussite", POURCENT),
        ("jetons_entree", "SUM(prompt_tokens)", "Jetons en entrée", NOMBRE),
        ("jetons_sortie", "SUM(completion_tokens)", "Jetons en sortie", NOMBRE),
        ("jetons", "SUM(total_tokens)", "Jetons", NOMBRE),
    ],
    "v_activity": [("equipes_actives", "MAX(active_teams)", "Équipes actives", NOMBRE),
                   ("cles_actives", "MAX(active_keys)", "Clés actives", NOMBRE)],
    "v_daily_user": [("cout", "SUM(spend)", "Coût (€)", EUROS), ("requetes", "SUM(api_requests)", "Requêtes", NOMBRE),
                     ("jetons", "SUM(prompt_tokens + completion_tokens)", "Jetons", NOMBRE)],
    "v_requests": [
        ("requetes", "COUNT(*)", "Requêtes", NOMBRE),
        ("taux_erreur", "AVG(CASE WHEN status = 'success' THEN 0.0 ELSE 1.0 END)", "Taux d'erreur", POURCENT),
        ("latence_moyenne", "AVG(request_duration_ms) FILTER (WHERE status = 'success')", "Latence moyenne (ms)", MS),
        ("latence_p95", "percentile_cont(0.95) WITHIN GROUP (ORDER BY request_duration_ms) FILTER (WHERE status = 'success')",
         "Latence p95 (ms)", MS),
    ],
    "v_check_pricing_eur": [("requetes", "COALESCE(SUM(requests), 0)", "Requêtes", NOMBRE)],
    "v_team_subscriptions": [("abonnements", "SUM(active_subscriptions)", "Abonnements en cours", NOMBRE),
                             ("cout_mensuel", "SUM(monthly_cost_ttc)", "Coût mensuel (€ TTC)", EUROS)],
    "v_team_monthly_cost": COUTS_MENSUELS,
    "v_user_monthly_cost": COUTS_MENSUELS,
}


def uid(nom):
    return uuid.uuid5(ESPACE, nom)


def periode(ds):
    return [{"clause": "WHERE", "expressionType": "SIMPLE", "subject": TEMPS[ds], "operator": "TEMPORAL_RANGE", "comparator": "No filter"}]


def sql(expression):
    return {"clause": "WHERE", "expressionType": "SQL", "sqlExpression": expression}


def kpi(ds, metrique, fmt):
    """Grand nombre comparé à la période précédente de même durée."""
    return {"viz_type": "pop_kpi", "metric": metrique, "adhoc_filters": periode(ds), "time_compare": ["inherit"],
            "comparison_type": "values", "y_axis_format": fmt, "percentDifferenceFormat": POURCENT,
            "header_font_size": 0.3, "subheader_font_size": 0.125, "comparison_color_enabled": True}


def nombre(metrique, fmt, sous_titre, filtres):
    return {"viz_type": "big_number_total", "metric": metrique, "adhoc_filters": filtres, "y_axis_format": fmt,
            "subheader": sous_titre, "header_font_size": 0.3, "subheader_font_size": 0.125}


def serie(viz, ds, metriques, fmt, groupby=(), empile=False, limite=0, filtres=()):
    return {"viz_type": viz, "x_axis": TEMPS[ds], "time_grain_sqla": "P1D", "metrics": list(metriques), "groupby": list(groupby),
            "adhoc_filters": periode(ds) + list(filtres), "row_limit": 10000, "series_limit": limite,
            "series_limit_metric": metriques[0] if limite else None, "order_desc": True, "stack": "Stack" if empile else None,
            "y_axis_format": fmt, "x_axis_time_format": "smart_date", "tooltipTimeFormat": "%d/%m/%Y", "rich_tooltip": True,
            "tooltipSortByMetric": True, "show_legend": True, "legendType": "scroll", "legendOrientation": "top",
            "markerEnabled": viz == "echarts_timeseries_line", "markerSize": 6, "truncateYAxis": False, "zoomable": False}


def tableau(ds, groupby, metriques, limite=20, filtres=()):
    return {"viz_type": "table", "query_mode": "aggregate", "groupby": list(groupby), "metrics": list(metriques),
            "percent_metrics": [], "adhoc_filters": (periode(ds) if ds in TEMPS else []) + list(filtres),
            "timeseries_limit_metric": metriques[0], "order_desc": True, "row_limit": limite, "server_page_length": 10,
            "show_cell_bars": True, "color_pn": False, "include_search": False, "table_timestamp_format": "%d/%m/%Y"}


def liste(colonnes, tri, filtres=(), formats=None, alertes=None, croissant=False):
    return {"viz_type": "table", "query_mode": "raw", "all_columns": list(colonnes), "order_by_cols": [json.dumps([tri, croissant])],
            "adhoc_filters": list(filtres), "row_limit": 500, "server_page_length": 20, "include_search": True,
            "table_timestamp_format": "%d/%m/%Y", "column_config": formats or {}, "conditional_formatting": alertes or []}


def mensuel(metriques, filtres=(), empile=True):
    """Barres par mois sur les douze derniers mois, mois en cours compris (jeux de données de MOIS)."""
    return {"viz_type": "echarts_timeseries_bar", "x_axis": "month", "time_grain_sqla": "P1M", "metrics": list(metriques), "groupby": [],
            "adhoc_filters": [DOUZE_MOIS, *filtres], "row_limit": 10000, "series_limit": 0, "order_desc": True,
            "stack": "Stack" if empile else None, "y_axis_format": EUROS, "x_axis_time_format": "%m/%Y", "tooltipTimeFormat": "%m/%Y",
            "rich_tooltip": True, "tooltipSortByMetric": True, "show_legend": True, "legendType": "scroll", "legendOrientation": "top",
            "truncateYAxis": False, "zoomable": False}


def camembert(ds, groupby, metrique, fmt):
    return {"viz_type": "pie", "groupby": [groupby], "metric": metrique, "adhoc_filters": periode(ds) if ds in TEMPS else [], "row_limit": 20,
            "sort_by_metric": True, "show_labels": True, "label_type": "key_percent", "labels_outside": True, "label_line": True,
            "number_format": fmt, "donut": True, "innerRadius": 40, "outerRadius": 70, "show_legend": True,
            "legendType": "scroll", "legendOrientation": "top"}


def pivot(ds, lignes, metriques):
    return {"viz_type": "pivot_table_v2", "groupbyRows": list(lignes), "groupbyColumns": [], "metrics": list(metriques),
            "metricsLayout": "COLUMNS", "adhoc_filters": periode(ds), "row_limit": 10000, "aggregateFunction": "Sum",
            "valueFormat": "SMART_NUMBER", "rowSubTotals": True, "rowTotals": False, "colTotals": True, "colSubTotals": False,
            "transposePivot": False, "combineMetric": False, "rowOrder": "key_a_to_z", "colOrder": "key_a_to_z"}


BUDGET = {"budget_used": {"d3NumberFormat": ".0%"}, "spend": {"d3NumberFormat": EUROS}, "max_budget": {"d3NumberFormat": EUROS}}
DOUZE_MOIS = sql("month >= date_trunc('month', current_date) - interval '11 months'")
MOIS_EN_COURS = sql("month = date_trunc('month', current_date)")
ALERTE_80 = [{"column": "budget_used", "operator": "≥", "targetValue": 0.8, "colorScheme": "#E04355"}]
SANS_MODELE = sql("model_name IS NOT NULL")


def definitions():
    """(tableau, section, graphiques) ; graphique = (nom, jeu de données, paramètres, largeur, hauteur, description)."""
    u, a, c = "v_usage_daily", "v_team_subscriptions", "v_team_monthly_cost"
    consommation = [
        (None, [
            [("Coût total", u, kpi(u, "cout", EUROS), 4, 36, "Comparé à la période précédente de même durée"),
             ("Requêtes", u, kpi(u, "requetes", NOMBRE), 4, 36, "Comparées à la période précédente de même durée"),
             ("Taux de réussite", u, nombre("taux_reussite", POURCENT, "des requêtes de la période", periode(u)), 4, 36, None)],
            [("Jetons en entrée", u, kpi(u, "jetons_entree", NOMBRE), 3, 36, None),
             ("Jetons en sortie", u, kpi(u, "jetons_sortie", NOMBRE), 3, 36, None),
             ("Équipes actives", "v_activity", nombre("equipes_actives", NOMBRE, "sur les 30 derniers jours", [sql("window_days = 30")]), 3, 36,
              "Équipes ayant consommé sur les 30 derniers jours"),
             ("Clés actives", "v_activity", nombre("cles_actives", NOMBRE, "sur les 30 derniers jours", [sql("window_days = 30")]), 3, 36,
              "Clés ayant consommé sur les 30 derniers jours")],
        ]),
        ("Vue d'ensemble", [
            [("Coût par jour et par modèle", u, serie("echarts_timeseries_bar", u, ["cout"], EUROS, ["model_name"], empile=True, limite=10), 6, 50, None),
             ("Requêtes par jour", u, serie("echarts_timeseries_bar", u, ["reussies", "echecs"], NOMBRE, empile=True), 6, 50, None)],
            [("Jetons par jour", u, serie("echarts_timeseries_line", u, ["jetons_entree", "jetons_sortie"], NOMBRE), 6, 50, None),
             ("Modèles les plus utilisés", u, tableau(u, ["model_name", "provider"], ["cout", "requetes", "jetons"], limite=10), 6, 50,
              "Classés par coût sur la période")],
            [("Coût par fournisseur", u, camembert(u, "provider", "cout", EUROS), 6, 50, None),
             ("Coût par hébergement", u, camembert(u, "hosting", "cout", EUROS), 6, 50, "UE, hors UE, OVHcloud")],
        ]),
        ("Par équipe", [
            [("Consommation par équipe", u, tableau(u, ["team"], ["cout", "requetes", "jetons"], limite=50), 6, 50, None),
             ("Coût par jour et par équipe", u, serie("echarts_timeseries_line", u, ["cout"], EUROS, ["team"], limite=10), 6, 50, None)],
            [("Budget des équipes", "v_team_budget", liste(["team", "spend", "max_budget", "budget_used", "budget_duration", "budget_reset_at"],
                                                          "budget_used", formats=BUDGET, alertes=ALERTE_80), 12, 44,
              "Dépense de la période de budget en cours ; en rouge à partir de 80 %")],
        ]),
        ("Par niveau de sensibilité", [
            [("Coût par niveau déclaré", u, camembert(u, "key_level", "cout", EUROS), 4, 56, "Niveau déclaré dans la demande de clé"),
             ("Modèles utilisés par niveau", u, pivot(u, ["key_level", "model_name"], ["cout", "requetes", "jetons"]), 8, 56, None)],
        ]),
        # Spécification #51, ticket #60 : abonnements individuels, en € TTC ; la passerelle reste en € HT.
        ("Abonnements", [
            [("Abonnements en cours par équipe, fournisseur et offre", a, tableau(a, ["team", "supplier", "offer"], ["abonnements", "cout_mensuel"],
                                                                              limite=100), 8, 50,
              "Abonnements actifs ou à résilier ; coût mensuel en € TTC"),
             ("Coût mensuel des abonnements par fournisseur", a, camembert(a, "supplier", "cout_mensuel", EUROS), 4, 50, "En € TTC")],
            [("Coût mensuel : passerelle et abonnements", c, mensuel(["passerelle", "abonnements"]), 12, 50,
              "Douze derniers mois ; passerelle en € HT, abonnements en € TTC (prélèvements du mois)")],
            [("Coût du mois en cours par équipe", c, tableau(c, ["team"], ["total", "passerelle", "abonnements"], limite=100, filtres=[MOIS_EN_COURS]),
              12, 44, "Total : passerelle en € HT et abonnements en € TTC")],
        ]),
    ]
    j, r, k = "v_daily_user", "v_requests", "v_key_status"
    pilotage = [
        ("Utilisateurs et clés", [
            [("Plus gros consommateurs", j, tableau(j, ["user_email", "team_alias"], ["cout", "requetes", "jetons"]), 6, 50, None),
             ("Clés les plus utilisées", j, tableau(j, ["key_alias", "team_alias", "key_data_level"], ["cout", "requetes"]), 6, 50, None)],
            [("Clés à 80 % de leur budget ou plus", k, liste(["key_alias", "user_email", "team", "key_level", "spend", "max_budget", "budget_used",
                                                            "budget_duration", "budget_reset_at"], "budget_used",
                                                           [sql("budget_used >= 0.8 AND status = 'Active'")], BUDGET, ALERTE_80), 12, 40, None)],
            [("Clés sans utilisation depuis 30 jours ou plus", k, liste(["key_alias", "user_email", "team", "key_level", "last_used", "created_at",
                                                                         "days_inactive", "expires"], "days_inactive",
                                                                        [sql("days_inactive >= 30 AND status = 'Active'")]), 12, 40, None)],
        ]),
        ("Qualité de service", [
            [("Qualité de service par modèle", r, tableau(r, ["model_name", "provider"], ["requetes", "taux_erreur", "latence_moyenne", "latence_p95"],
                                                          limite=50, filtres=[SANS_MODELE]), 7, 50, "Latences mesurées sur les requêtes réussies"),
             ("Qualité de service par fournisseur", r, tableau(r, ["provider"], ["requetes", "taux_erreur", "latence_moyenne", "latence_p95"],
                                                               limite=20, filtres=[SANS_MODELE]), 5, 50, None)],
            [("Taux d'erreur par jour et par fournisseur", r, serie("echarts_timeseries_line", r, ["taux_erreur"], POURCENT, ["provider"],
                                                                   filtres=[SANS_MODELE]), 6, 50, None),
             ("Latence p95 par jour et par modèle", r, serie("echarts_timeseries_line", r, ["latence_p95"], MS, ["model_name"], limite=10,
                                                            filtres=[SANS_MODELE]), 6, 50, None)],
        ]),
        ("Contrôle devise", [
            [("Requêtes sans tarif en euros", "v_check_pricing_eur", nombre("requetes", NOMBRE, "doit rester à 0", periode("v_check_pricing_eur")), 4, 40,
              "Requêtes sur des modèles sans tarif EUR explicite : leur coût n'est pas fiable"),
             ("Modèles sans tarif en euros", "v_models", liste(["model_name", "fournisseur", "pricing_currency", "data_level", "hosting"], "model_name",
                                                            [sql("pricing_currency IS DISTINCT FROM 'EUR'")], croissant=True), 8, 40,
              "Ces modèles ne peuvent pas être rendus visibles au catalogue")],
        ]),
    ]
    # Par salarié (spécification #51, ticket #52) : la dépense et les clés d'un salarié, choisi dans le filtre.
    par_salarie = [
        (None, [
            [("Coût de la passerelle", j, kpi(j, "cout", EUROS), 4, 36, "Comparé à la période précédente de même durée"),
             ("Requêtes", j, kpi(j, "requetes", NOMBRE), 4, 36, "Comparées à la période précédente de même durée"),
             ("Jetons", j, kpi(j, "jetons", NOMBRE), 4, 36, None)],
        ]),
        ("Dépense de la passerelle", [
            [("Coût par jour et par modèle", j, serie("echarts_timeseries_bar", j, ["cout"], EUROS, ["model_name"], empile=True, limite=10), 12, 50,
              None)],
            [("Coût par modèle", j, tableau(j, ["model_name", "provider"], ["cout", "requetes", "jetons"]), 6, 50, "Classés par coût sur la période"),
             ("Coût par niveau déclaré", j, camembert(j, "key_level", "cout", EUROS), 6, 50, "Niveau déclaré dans la demande de clé")],
            [("Coût par clé", j, tableau(j, ["key_alias", "team_alias", "key_level"], ["cout", "requetes", "jetons"], limite=50), 12, 44, None)],
        ]),
        ("Clés", [
            [("Clés du salarié", k, liste(["key_alias", "team", "key_level", "status", "spend", "max_budget", "budget_used", "budget_duration",
                                          "expires", "last_used"], "key_alias", formats=BUDGET, alertes=ALERTE_80, croissant=True), 12, 44,
              "Part du budget consommée ; en rouge à partir de 80 %")],
        ]),
        # Ticket #60 : ses abonnements individuels, et son coût mensuel total.
        ("Abonnements", [
            [("Abonnements du salarié", "v_subscriptions", liste(["offer_label", "team", "monthly_amount_eur", "subscribed_on", "expires_on", "status",
                                                                  "terminated_on", "account_outside_linagora"], "subscribed_on",
                                                                 formats={"monthly_amount_eur": {"d3NumberFormat": EUROS}}), 12, 40,
              "Montant mensuel en € TTC ; une adresse de compte hors LINAGORA est signalée")],
            [("Coût mensuel du salarié : passerelle et abonnements", "v_user_monthly_cost", mensuel(["passerelle", "abonnements"]), 12, 50,
              "Douze derniers mois ; passerelle en € HT, abonnements en € TTC (prélèvements du mois)")],
        ]),
    ]
    return {"consommation": ("Consommation", consommation), "pilotage": ("Pilotage", pilotage), "par-salarie": ("Par salarié", par_salarie)}


app = create_app()
with app.app_context():
    from superset import db, security_manager as sm
    from superset.connectors.sqla.models import SqlaTable, SqlMetric
    from superset.models.dashboard import Dashboard
    from superset.models.core import Database
    from superset.models.slice import Slice

    base = db.session.query(Database).filter_by(database_name="LiteLLM reporting").one()
    jeux = {t.table_name: t for t in db.session.query(SqlaTable).filter_by(schema="reporting", database_id=base.id)}

    # Libellés, colonne de temps et métriques des jeux de données
    for nom, libelles in LIBELLES.items():
        ds = jeux[nom]
        for col in ds.columns:
            if col.column_name in libelles:
                col.verbose_name = libelles[col.column_name]
            if col.column_name == TEMPS.get(nom, MOIS.get(nom)):
                col.is_dttm = True
        ds.main_dttm_col = TEMPS.get(nom, MOIS.get(nom))
        existantes = {m.metric_name: m for m in ds.metrics}
        for cle, expression, libelle, fmt in METRIQUES.get(nom, []):
            m = existantes.get(cle) or SqlMetric(metric_name=cle, table=ds)
            m.expression, m.verbose_name, m.d3format = expression, libelle, fmt
            if cle not in existantes:
                ds.metrics.append(m)
    db.session.flush()

    proprietaires = [u for u in [sm.find_user(username="mmaudet")] if u]
    admin, lecteur = sm.find_role("Admin"), sm.find_role("Lecteur reporting")
    droits = {"consommation": [admin, lecteur], "pilotage": [admin], "par-salarie": [admin]}

    for slug, (titre, sections) in definitions().items():
        graphiques, position = [], {
            "DASHBOARD_VERSION_KEY": "v2",
            "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
            "GRID_ID": {"type": "GRID", "id": "GRID_ID", "children": [], "parents": ["ROOT_ID"]},
            "HEADER_ID": {"type": "HEADER", "id": "HEADER_ID", "meta": {"text": titre}},
        }
        sans_temps, hors_equipe, hors_niveau = [], [], []
        n = 0
        for section, rangees in sections:
            if section:
                n += 1
                rid, mid = f"ROW-{slug}-{n}", f"MARKDOWN-{slug}-{n}"
                position[rid] = {"type": "ROW", "id": rid, "children": [mid], "parents": ["ROOT_ID", "GRID_ID"],
                                 "meta": {"background": "BACKGROUND_TRANSPARENT"}}
                position[mid] = {"type": "MARKDOWN", "id": mid, "children": [], "parents": ["ROOT_ID", "GRID_ID", rid],
                                 "meta": {"width": 12, "height": 7, "code": f"## {section}"}}
                position["GRID_ID"]["children"].append(rid)
            for rangee in rangees:
                n += 1
                rid = f"ROW-{slug}-{n}"
                position[rid] = {"type": "ROW", "id": rid, "children": [], "parents": ["ROOT_ID", "GRID_ID"],
                                 "meta": {"background": "BACKGROUND_TRANSPARENT"}}
                position["GRID_ID"]["children"].append(rid)
                for nom, jeu, params, largeur, hauteur, description in rangee:
                    ds = jeux[jeu]
                    u = uid(f"graphique/{slug}/{nom}")
                    slc = db.session.query(Slice).filter_by(uuid=u).one_or_none() or Slice(uuid=u)
                    slc.slice_name, slc.viz_type, slc.description = nom, params["viz_type"], description
                    slc.datasource_type, slc.datasource_id = "table", ds.id
                    slc.params = json.dumps({**params, "datasource": f"{ds.id}__table"}, ensure_ascii=False)
                    slc.owners = proprietaires
                    db.session.add(slc)
                    db.session.flush()
                    graphiques.append(slc)
                    cid = f"CHART-{u.hex[:12]}"
                    position[cid] = {"type": "CHART", "id": cid, "children": [], "parents": ["ROOT_ID", "GRID_ID", rid],
                                     "meta": {"chartId": slc.id, "width": largeur, "height": hauteur, "sliceName": nom, "uuid": str(u)}}
                    position[rid]["children"].append(cid)
                    if jeu not in TEMPS:
                        sans_temps.append(slc.id)
                    if jeu not in JEUX_PAR_EQUIPE:
                        hors_equipe.append(slc.id)
                    if jeu != "v_usage_daily":
                        hors_niveau.append(slc.id)

        tous = [g.id for g in graphiques]
        filtres = [{"id": f"NATIVE_FILTER-{slug}-periode", "name": "Période", "filterType": "filter_time", "targets": [{}],
                    "defaultDataMask": {"extraFormData": {"time_range": PERIODE}, "filterState": {"value": PERIODE}},
                    "controlValues": {}, "cascadeParentIds": [], "type": "NATIVE_FILTER",
                    "description": "30 derniers jours par défaut, aujourd'hui compris",
                    "scope": {"rootPath": ["ROOT_ID"], "excluded": sans_temps},
                    "chartsInScope": [i for i in tous if i not in sans_temps], "tabsInScope": []}]
        if slug == "consommation":
            for cle, libelle, colonne, exclus in [("equipe", "Équipe", "team", hors_equipe), ("niveau", "Niveau déclaré de la clé", "key_level", hors_niveau)]:
                filtres.append({"id": f"NATIVE_FILTER-{slug}-{cle}", "name": libelle, "filterType": "filter_select",
                                "targets": [{"datasetId": jeux["v_usage_daily"].id, "column": {"name": colonne}}],
                                "defaultDataMask": {"extraFormData": {}, "filterState": {}, "ownState": {}},
                                "controlValues": {"enableEmptyFilter": False, "defaultToFirstItem": False, "multiSelect": True,
                                                  "searchAllOptions": False, "inverseSelection": False},
                                "cascadeParentIds": [], "type": "NATIVE_FILTER", "description": "",
                                "scope": {"rootPath": ["ROOT_ID"], "excluded": exclus},
                                "chartsInScope": [i for i in tous if i not in exclus], "tabsInScope": []})
        if slug == "par-salarie":
            # Salarié obligatoire, un seul à la fois ; la liste vient des utilisateurs de la passerelle, et le filtre
            # porte sur la colonne user_id de chaque jeu de données du tableau.
            filtres.append({"id": f"NATIVE_FILTER-{slug}-salarie", "name": "Salarié (uid)", "filterType": "filter_select",
                            "targets": [{"datasetId": jeux["v_users"].id, "column": {"name": "user_id"}}],
                            "defaultDataMask": {"extraFormData": {}, "filterState": {}, "ownState": {}},
                            "controlValues": {"enableEmptyFilter": True, "defaultToFirstItem": False, "multiSelect": False,
                                              "searchAllOptions": True, "inverseSelection": False},
                            "cascadeParentIds": [], "type": "NATIVE_FILTER",
                            "description": "Obligatoire : les graphiques s'affichent une fois le salarié choisi",
                            "scope": {"rootPath": ["ROOT_ID"], "excluded": []}, "chartsInScope": tous, "tabsInScope": []})

        u = uid(f"tableau/{slug}")
        tdb = db.session.query(Dashboard).filter_by(uuid=u).one_or_none() or Dashboard(uuid=u)
        tdb.dashboard_title, tdb.slug, tdb.published = titre, slug, True
        tdb.owners, tdb.roles, tdb.slices = proprietaires, droits[slug], graphiques
        tdb.position_json = json.dumps(position, ensure_ascii=False)
        tdb.json_metadata = json.dumps({"native_filter_configuration": filtres, "chart_configuration": {}, "cross_filters_enabled": False,
                                        "color_scheme": "supersetColors", "label_colors": {}, "shared_label_colors": [],
                                        "refresh_frequency": 0, "timed_refresh_immune_slices": [], "expanded_slices": {},
                                        "default_filters": "{}", "filter_scopes": {}}, ensure_ascii=False)
        db.session.add(tdb)
        db.session.flush()
        print(f"• tableau « {titre} » (/stats/superset/dashboard/{slug}/) : {len(graphiques)} graphiques, "
              f"accès : {', '.join(r.name for r in droits[slug])}")
    db.session.commit()
