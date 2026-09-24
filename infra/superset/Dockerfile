# Image Superset + pilote Postgres + Authlib (OIDC).
# L'image officielle "lean" ne contient pas psycopg2 ; la méthode d'installation dépend
# de la version (pip ou uv dans /app/.venv). L'agent DOIT vérifier la méthode indiquée
# dans la doc Superset "Docker builds" pour le tag choisi et adapter la ligne RUN.
ARG SUPERSET_BASE_IMAGE
FROM ${SUPERSET_BASE_IMAGE}

USER root
RUN if [ -x /app/.venv/bin/python ] && command -v uv >/dev/null 2>&1; then \
      uv pip install --python /app/.venv/bin/python --no-cache psycopg2-binary Authlib; \
    else \
      pip install --no-cache-dir psycopg2-binary Authlib; \
    fi
USER superset
