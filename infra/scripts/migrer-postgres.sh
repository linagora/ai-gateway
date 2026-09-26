#!/usr/bin/env bash
# Montée de version majeure de PostgreSQL (16.15 → 18.6 le 2026-09-26) par export et réimport, avec retour arrière.
# Prérequis : POSTGRES_IMAGE du .env désigne déjà la nouvelle image, et docker-compose.yml monte le nouveau volume
# (PostgreSQL ≥ 18 : volume sur /var/lib/postgresql) ; le conteneur postgres tourne encore avec l'ancienne version.
#   1. arrête les services qui écrivent (portal, litellm, superset) ;
#   2. compte les lignes de chaque table, puis exporte tout (pg_dumpall : rôles et bases) dans backups/ (droits 600) ;
#   3. recrée le conteneur postgres sans le démarrer : nouvelle image, nouveau volume, vide ;
#   4. réimporte l'export dans un conteneur temporaire, sans réseau ni scripts d'initialisation (les rôles et les bases
#      viennent de l'export) ; arrêt à la première erreur ;
#   5. démarre le nouveau serveur, recalcule les statistiques, compare les lignes table par table.
# Les services restent arrêtés : on les redémarre après les contrôles (docker compose --profile portal up -d).
# L'ancien volume n'est jamais touché. Retour arrière : remettre l'ancienne image dans le .env et l'ancien montage
# (pg_data:/var/lib/postgresql/data) dans docker-compose.yml, puis docker compose up -d postgres.
# Aucun mot de passe n'est affiché ni passé en argument.
#
#   ssh ia-host 'cd /opt/linagora-ia && scripts/migrer-postgres.sh'
set -euo pipefail
cd "$(dirname "$0")/.."

U="$(grep '^POSTGRES_USER=' .env | cut -d= -f2-)"
U="${U:-postgres}"
IMAGE="$(grep '^POSTGRES_IMAGE=' .env | cut -d= -f2-)"
VERSION="${IMAGE#*:}"
VERSION="${VERSION%%@*}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
EXPORT="backups/postgres-dumpall-${STAMP}.sql"
TEMPORAIRE=postgres-migration

# Nombre exact de lignes de chaque table de chaque base, « base.schéma.table nombre », trié.
compter() {
  local bases
  bases="$(docker compose exec -T postgres psql -U "$U" -d postgres -At -c "select datname from pg_database where not datistemplate and datname <> 'postgres' order by 1")"
  for base in $bases; do
    docker compose exec -T postgres psql -U "$U" -d "$base" -X -At -v ON_ERROR_STOP=1 <<SQL
select format('select %L || '' '' || count(*) from %I.%I', '${base}.' || schemaname || '.' || relname, schemaname, relname)
from pg_stat_user_tables order by schemaname, relname \gexec
SQL
  done | sort
}

avant="$(docker compose exec -T postgres psql -U "$U" -At -c 'show server_version')"
echo "• serveur actuel : PostgreSQL ${avant} ; nouvelle image : PostgreSQL ${VERSION}"
case "$avant" in "$VERSION"*) echo "Déjà sur la nouvelle version : rien à faire." >&2; exit 1 ;; esac

# 1. Services qui écrivent dans la base
docker compose --profile portal stop portal litellm superset
echo "• services arrêtés : portal, litellm, superset"

# 2. Comptes et export
compter > "backups/postgres-comptes-avant-${STAMP}.txt"
umask 077
docker compose exec -T postgres pg_dumpall -U "$U" > "$EXPORT"
echo "• export : ${EXPORT} ($(du -h "$EXPORT" | cut -f1)), $(wc -l < "backups/postgres-comptes-avant-${STAMP}.txt") tables comptées"

# 3. Nouveau conteneur, sur le nouveau volume, pas encore démarré
docker compose stop postgres
docker compose up --no-start postgres
VOLUME="$(docker inspect "$(docker compose ps -a -q postgres)" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Name}}{{end}}{{end}}')"
[ -n "$VOLUME" ] || { echo "Le conteneur postgres ne monte pas de volume sur /var/lib/postgresql : docker-compose.yml à jour ?" >&2; exit 1; }
if docker run --rm -v "${VOLUME}:/v:ro" --entrypoint sh "$IMAGE" -c 'find /v -name PG_VERSION | grep -q .'; then
  echo "Le volume ${VOLUME} contient déjà un serveur : arrêt (rien n'a été réimporté)." >&2
  exit 1
fi

# 4. Réimport dans un conteneur temporaire, sans réseau ni scripts d'initialisation
docker rm -f "$TEMPORAIRE" > /dev/null 2>&1 || true
POSTGRES_PASSWORD="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)" POSTGRES_USER="$U" \
  docker run -d --name "$TEMPORAIRE" --network none -e POSTGRES_PASSWORD -e POSTGRES_USER -v "${VOLUME}:/var/lib/postgresql" "$IMAGE" > /dev/null
for _ in $(seq 1 90); do
  [ "$(docker logs "$TEMPORAIRE" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done
# Le superutilisateur existe déjà dans un serveur neuf : seule sa création est écartée de l'export.
grep -v "^CREATE ROLE ${U};\$" "$EXPORT" | docker exec -i "$TEMPORAIRE" psql -U "$U" -d postgres -X -q -v ON_ERROR_STOP=1 > /dev/null
docker stop "$TEMPORAIRE" > /dev/null && docker rm "$TEMPORAIRE" > /dev/null
echo "• réimport dans ${VOLUME} : sans erreur"

# 5. Nouveau serveur, statistiques, comparaison
docker compose up -d postgres
for _ in $(seq 1 60); do docker compose exec -T postgres pg_isready -U "$U" -h 127.0.0.1 > /dev/null 2>&1 && break; sleep 1; done
docker compose exec -T postgres vacuumdb -U "$U" --all --analyze-only --quiet
compter > "backups/postgres-comptes-apres-${STAMP}.txt"
echo "• nouveau serveur : PostgreSQL $(docker compose exec -T postgres psql -U "$U" -At -c 'show server_version')"
if diff -q "backups/postgres-comptes-avant-${STAMP}.txt" "backups/postgres-comptes-apres-${STAMP}.txt" > /dev/null; then
  echo "• lignes identiques dans les $(wc -l < "backups/postgres-comptes-apres-${STAMP}.txt") tables ; redémarrer les services après contrôle"
else
  diff "backups/postgres-comptes-avant-${STAMP}.txt" "backups/postgres-comptes-apres-${STAMP}.txt" >&2 || true
  echo "ÉCARTS DE LIGNES : services laissés arrêtés ; examiner, ou revenir en arrière (voir l'en-tête)." >&2
  exit 1
fi
