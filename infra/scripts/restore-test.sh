#!/usr/bin/env bash
# Test de restauration (PRD §8 et critère d'acceptation 9). Restaure la dernière sauvegarde de la
# base litellm (avec les rôles) dans un conteneur Postgres jetable et sans réseau, vérifie que les
# tables et les vues de reporting répondent, affiche les volumes à côté de ceux de la production,
# puis supprime le conteneur. Ne touche jamais au Postgres de production.
# Usage : sudo /opt/linagora-ia/scripts/restore-test.sh
set -euo pipefail
cd /opt/linagora-ia

IMG=$(grep ^POSTGRES_IMAGE= .env | cut -d= -f2-)
D=/var/backups/linagora-ia
L=$(ls -1t "$D"/litellm-*.dump | head -1)
G=$(ls -1t "$D"/globals-*.sql | head -1)
C=restore-test
echo "• sauvegarde testée : $(basename "$L") + $(basename "$G")"

trap 'docker rm -f -v "$C" >/dev/null 2>&1 || true' EXIT
docker rm -f -v "$C" >/dev/null 2>&1 || true
docker run -d --name "$C" --network none -e POSTGRES_PASSWORD=restore-test-only "$IMG" >/dev/null
# L'image démarre un serveur temporaire (initdb) puis le serveur définitif : attendre le 2e « ready »
for _ in $(seq 1 60); do
  [ "$(docker logs "$C" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ] && break
  sleep 1
done

docker exec -i "$C" psql -U postgres -q < "$G" 2>&1 | grep -v "already exists" || true
docker exec "$C" createdb -U postgres -O litellm litellm < /dev/null
docker exec -i "$C" pg_restore -U postgres -d litellm < "$L"

Q='select (select count(*) from "LiteLLM_ProxyModelTable"), (select count(*) from "LiteLLM_SpendLogs"),
          (select count(*) from "LiteLLM_VerificationToken"), (select count(*) from "LiteLLM_DeletedVerificationToken"),
          (select count(*) from reporting.v_requests)'
rest=$(docker exec "$C" psql -U postgres -d litellm -At -F ' | ' -c "$Q" < /dev/null)
prod=$(docker compose exec -T postgres psql -U litellm -d litellm -At -F ' | ' -c "$Q" < /dev/null)
ro=$(docker exec "$C" psql -U reporting_ro -d litellm -At -c 'select count(*) from v_requests' < /dev/null)
echo "• colonnes     : modèles | requêtes | clés | clés supprimées | v_requests"
echo "• restauration : $rest"
echo "• production   : $prod   (a pu évoluer depuis la sauvegarde)"
echo "• reporting_ro lit v_requests sur la base restaurée : $ro ligne(s)"
echo "RÉSULTAT : OK — sauvegarde restaurée, tables et vues de reporting opérationnelles"
