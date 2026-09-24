# Image Superset + pilote Postgres + Authlib (OIDC).
# L'image officielle "lean" ne contient pas psycopg2. Méthode de la doc « Docker builds » de
# Superset 6.1.0 : installation avec uv dans l'environnement virtuel /app/.venv.
# À revérifier à chaque changement de version (docs/admin_docs/installation/docker-builds.mdx).
ARG SUPERSET_BASE_IMAGE
FROM ${SUPERSET_BASE_IMAGE}

USER root
RUN . /app/.venv/bin/activate && \
    uv pip install --no-cache psycopg2-binary Authlib && \
    python -c "import psycopg2, authlib"
USER superset
