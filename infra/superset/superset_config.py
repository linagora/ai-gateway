"""Configuration Superset — Passerelle IA Linagora.

Authentification OIDC via LemonLDAP::NG. L'annuaire n'ayant pas de groupes,
l'auto-inscription est DÉSACTIVÉE : seuls les comptes créés au préalable dans
Superset (username = uid LDAP) peuvent se connecter.
"""
import os

from flask_appbuilder.security.manager import AUTH_OAUTH
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

# --- OIDC LemonLDAP::NG ----------------------------------------------------
OIDC_ISSUER = os.environ.get("OIDC_ISSUER", "https://sso.linagora.com").rstrip("/")

AUTH_TYPE = AUTH_OAUTH
AUTH_USER_REGISTRATION = False  # comptes pré-créés uniquement
AUTH_ROLES_SYNC_AT_LOGIN = False

OAUTH_PROVIDERS = [
    {
        "name": "lemonldap",
        "icon": "fa-key",
        "token_key": "access_token",
        "remote_app": {
            "client_id": os.environ["SUPERSET_OIDC_CLIENT_ID"],
            "client_secret": os.environ["SUPERSET_OIDC_CLIENT_SECRET"],
            "server_metadata_url": f"{OIDC_ISSUER}/.well-known/openid-configuration",
            "client_kwargs": {"scope": "openid email profile"},
        },
    }
]


class LemonLDAPSecurityManager(SupersetSecurityManager):
    """Mappe les claims OIDC vers un utilisateur Superset (username = uid)."""

    def oauth_user_info(self, provider, response=None):
        if provider != "lemonldap":
            return super().oauth_user_info(provider, response)
        me = self.appbuilder.sm.oauth_remotes[provider].userinfo()
        name = (me.get("name") or "").split(" ", 1)
        return {
            "username": me["sub"],
            "email": me.get("email", ""),
            "first_name": me.get("given_name") or name[0],
            "last_name": me.get("family_name") or (name[1] if len(name) > 1 else ""),
        }


CUSTOM_SECURITY_MANAGER = LemonLDAPSecurityManager

# Interface en français
BABEL_DEFAULT_LOCALE = "fr"
LANGUAGES = {"fr": {"flag": "fr", "name": "Français"}, "en": {"flag": "us", "name": "English"}}
