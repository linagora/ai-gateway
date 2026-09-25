"""Configuration Superset — Passerelle IA Linagora.

Authentification par le point de contrôle du portail : Caddy n'envoie une requête vers /stats
qu'après accord du portail (forward_auth), qui vérifie la session SSO et les listes d'uid
(PORTAL_ADMIN_UIDS, PORTAL_REPORTING_UIDS) puis transmet l'identité par les en-têtes X-Portal-User,
X-Portal-Role (admin | reader), X-Portal-Email et X-Portal-Name (encodé). Superset n'est joignable
que par Caddy, qui supprime ces en-têtes s'ils viennent du client. Pas de client OIDC pour Superset.
"""
import os
from urllib.parse import unquote

from flask import request
from flask_appbuilder.security.manager import AUTH_REMOTE_USER
from flask_login import current_user, logout_user
from superset.security import SupersetSecurityManager

SECRET_KEY = os.environ["SUPERSET_SECRET_KEY"]
SQLALCHEMY_DATABASE_URI = os.environ["SUPERSET_DATABASE_URI"]

# Derrière Caddy (TLS terminé par le proxy), servi sous https://ai-gateway.linagora.com/stats
# Le préfixe est fourni par la variable d'environnement SUPERSET_APP_ROOT=/stats (Superset ≥ 6).
# Fonction encore jeune : l'agent vérifie dans la doc de la version déployée si
# STATIC_ASSETS_PREFIX doit aussi être positionné, et si Caddy doit conserver le préfixe.
ENABLE_PROXY_FIX = True
PREFERRED_URL_SCHEME = "https"
# Même domaine que le portail et l'UI LiteLLM : cookie de session dédié pour éviter les collisions
SESSION_COOKIE_NAME = "superset_session"
SESSION_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"

# Cache et limitation de débit dans Redis
REDIS_HOST = os.environ.get("REDIS_HOST", "redis")
CACHE_CONFIG = {
    "CACHE_TYPE": "RedisCache",
    "CACHE_DEFAULT_TIMEOUT": 300,
    "CACHE_KEY_PREFIX": "superset_",
    "CACHE_REDIS_URL": f"redis://{REDIS_HOST}:6379/1",
}
DATA_CACHE_CONFIG = {**CACHE_CONFIG, "CACHE_KEY_PREFIX": "superset_data_"}
RATELIMIT_STORAGE_URI = f"redis://{REDIS_HOST}:6379/2"

# --- Identité transmise par le portail ---------------------------------------
AUTH_TYPE = AUTH_REMOTE_USER
AUTH_REMOTE_USER_ENV_VAR = "HTTP_X_PORTAL_USER"  # en-tête X-Portal-User (uid LDAP)
READER_ROLE = "Lecteur reporting"  # créé par superset/init-reporting.py


class PortalSecurityManager(SupersetSecurityManager):
    """Crée ou met à jour l'utilisateur transmis par le portail, avec le rôle correspondant."""

    # Superset 6 enregistre sinon sa propre page de connexion (React), qui ignore AUTH_REMOTE_USER :
    # sans elle, Flask-AppBuilder enregistre sa vue REMOTE_USER pour /login/.
    register_superset_auth_view = False

    def auth_user_remote_user(self, username):
        role = self.find_role("Admin" if request.headers.get("X-Portal-Role") == "admin" else READER_ROLE)
        if role is None:
            return None
        first_name, _, last_name = (unquote(request.headers.get("X-Portal-Name", "")) or username).partition(" ")
        email = request.headers.get("X-Portal-Email") or f"{username}@invalid"
        user = self.find_user(username=username)
        if user is None:
            user = self.add_user(username=username, first_name=first_name, last_name=last_name or "-", email=email, role=role)
            if not user:
                return None
        elif not user.is_active:
            return None
        elif [r.name for r in user.roles] != [role.name]:
            # Le rôle suit les listes du portail : un admin retiré redevient lecteur, et inversement.
            user.roles = [role]
            self.update_user(user)
        self.update_user_auth_stat(user)
        return user


CUSTOM_SECURITY_MANAGER = PortalSecurityManager


def FLASK_APP_MUTATOR(app):  # noqa: N802 (nom imposé par Superset)
    @app.before_request
    def follow_portal_identity():
        # Une session Superset ouverte au nom d'un autre utilisateur que celui transmis est fermée.
        # Une requête sans en-tête (lancée par le navigateur lui-même, comme le script du service
        # worker, hors du point de contrôle) ne ferme rien : derrière Caddy, toute requête vers /stats
        # porte l'identité transmise par le portail.
        utilisateur = request.headers.get("X-Portal-User")
        if utilisateur and current_user.is_authenticated and current_user.username != utilisateur:
            logout_user()

# Interface en français
BABEL_DEFAULT_LOCALE = "fr"
LANGUAGES = {"fr": {"flag": "fr", "name": "Français"}, "en": {"flag": "us", "name": "English"}}

# Nombres et dates à la française (montants : format « $,.2f » → 1 234,56 €)
D3_FORMAT = {"decimal": ",", "thousands": "\u202f", "grouping": [3], "currency": ["", "\u00a0€"]}
D3_TIME_FORMAT = {
    "dateTime": "%A %e %B %Y à %X",
    "date": "%d/%m/%Y",
    "time": "%H:%M:%S",
    "periods": ["AM", "PM"],
    "days": ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    "shortDays": ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."],
    "months": ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
               "novembre", "décembre"],
    "shortMonths": ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
}

# Tableaux de bord (superset/tableaux-de-bord.py) : accès par rôle à chaque tableau (« Pilotage »
# réservé aux admins) ; indicateur comparé à la période précédente (graphique pop_kpi, encore
# classé expérimental par Superset).
FEATURE_FLAGS = {"DASHBOARD_RBAC": True, "CHART_PLUGINS_EXPERIMENTAL": True}
