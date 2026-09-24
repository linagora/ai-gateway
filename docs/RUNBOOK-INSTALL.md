# Runbook — Installation distante de la Passerelle IA (agent de code → SSH → OVH B2-15)

Ce runbook est exécuté par **un agent de code sur le poste de l'administrateur**. Toutes les commandes serveur passent par `ssh ia-host`. Chaque phase se termine par des **contrôles** ; consigner le résultat dans `docs/INSTALL-LOG.md`.

Légende : 🧑 = point d'arrêt, action ou information attendue de l'utilisateur.

---

## Phase 0 — Prérequis sur le poste (🧑)

1. Agent de code installé ; ce dépôt cloné ; `ssh`, `rsync`, `git` disponibles.
2. Alias SSH dans `~/.ssh/config` :
   ```
   Host ia-host
       HostName <IP publique de l'instance OVH>
       User ubuntu            # utilisateur par défaut OVH (Ubuntu) ; "debian" sous Debian
       IdentityFile ~/.ssh/<clé>
       ServerAliveInterval 30
   ```
3. Informations à réunir (l'agent les demande en une fois) :
   - e-mail ACME (domaines fixés : `ai-gateway.linagora.com`, `ai-api.linagora.com` — PRD §4.2) ;
   - IP/CIDR autorisées pour SSH et pour `/admin` ;
   - uid des admins (≤ 5 pour le SSO admin LiteLLM) ;
   - clé d'API OpenRouter et paramètres de l'endpoint OVHcloud Qwen3.8 (URL, nom du modèle, clé, tarif EUR) — secrets saisis **directement sur le serveur** par l'utilisateur, voir phase 3 ;
   - taux interne USD→EUR pour convertir les tarifs OpenRouter ;
   - paramètres SMTP.

**Contrôle** : `ssh ia-host 'hostname; . /etc/os-release; echo $PRETTY_NAME; nproc; free -h; df -h /'` → 4 vCPU, ~15 Go RAM, ~100 Go disque, Ubuntu 24.04, Debian 12 ou Debian 13.

## Phase 1 — Préparation du serveur

```bash
scp infra/scripts/bootstrap-host.sh ia-host:/tmp/
ssh ia-host 'sudo ADMIN_SSH_CIDR="<CIDR séparés par des espaces, ou vide>" bash /tmp/bootstrap-host.sh'
```
⚠️ Le script autorise SSH **avant** d'activer ufw. Après exécution, **ouvrir une nouvelle connexion** (`ssh ia-host true`) avant de fermer quoi que ce soit.

**Contrôles** :
```bash
ssh ia-host 'docker version --format "{{.Server.Version}}" && docker compose version && sudo ufw status && sudo swapon --show && systemctl is-active fail2ban'
```

## Phase 2 — DNS (🧑)

L'utilisateur crée des enregistrements **A** (et AAAA si IPv6) vers l'IP de l'instance pour **`ai-gateway.linagora.com`** et **`ai-api.linagora.com`** (les autres services sont des chemins : `/admin`, `/stats`, `/traces`).

**Contrôle** : `dig +short <domaine>` renvoie l'IP de l'instance pour chacun (depuis le poste).

## Phase 3 — Déploiement des fichiers et secrets

```bash
rsync -av --exclude '.env' infra/ ia-host:/opt/linagora-ia/
ssh ia-host 'chmod +x /opt/linagora-ia/scripts/*.sh /opt/linagora-ia/postgres/init/*.sh && /opt/linagora-ia/scripts/gen-secrets.sh'
```
Le script liste les variables `__ASK__` restantes. L'agent renseigne celles qui ne sont pas secrètes (domaines, IP, uid, SMTP_HOST…) avec `sed -i` sur le serveur. Pour les **secrets fournis par l'utilisateur** (clé OpenRouter, `OVH_QWEN_API_BASE` / `OVH_QWEN_API_KEY`, secrets des clients OIDC, mot de passe SMTP) : 🧑 l'utilisateur les saisit lui-même, une variable à la fois, en saisie masquée (la valeur n'apparaît ni à l'écran, ni dans `ps`, ni dans l'historique) :
```bash
ssh -t ia-host '/opt/linagora-ia/scripts/set-env-var.sh OPENROUTER_API_KEY'
```
Autre possibilité : `ssh -t ia-host 'nano /opt/linagora-ia/.env'`, à condition que l'agent ne modifie pas le fichier au même moment.
**Contrôle** (sans afficher de valeur) : `ssh ia-host "grep -cE '^[A-Z0-9_]+=.*__(ASK|GENERATE)' /opt/linagora-ia/.env"` → `0` avant la phase 5 (les secrets OIDC peuvent attendre les phases 6 et 7 ; les laisser à `__ASK__` jusque-là).

## Phase 4 — Choix et vérification des versions

1. LiteLLM : identifier le dernier tag **`vX.Y.Z-stable`** sur `ghcr.io/berriai/litellm` (page Releases GitHub de BerriAI/litellm). Installer cosign sur le serveur (binaire de release GitHub sigstore/cosign, vérifier la somme SHA256), puis :
   ```bash
   cosign verify \
     --key https://raw.githubusercontent.com/BerriAI/litellm/0112e53046018d726492c814b3644b7d376029d0/cosign.pub \
     ghcr.io/berriai/litellm:<tag>
   ```
   Attendu : « The cosign claims were validated » et « The signatures were verified against the specified public key ». Sinon : **arrêt**.
2. Superset : dernier tag stable `apache/superset:<x.y.z>` ; adapter `superset/Dockerfile` selon la doc « Docker builds » de cette version.
3. Renseigner `LITELLM_IMAGE` et `SUPERSET_BASE_IMAGE` dans `.env`. Épingler de préférence par digest (`image@sha256:…`) une fois vérifié.

## Phase 5 — Socle : Postgres, LiteLLM, Caddy

```bash
ssh ia-host 'cd /opt/linagora-ia && docker compose pull postgres litellm caddy && docker compose up -d postgres litellm caddy'
```
**Contrôles** :
```bash
ssh ia-host 'cd /opt/linagora-ia && docker compose ps && docker compose logs --tail=50 litellm'
curl -s https://ai-api.linagora.com/health/liveliness                                   # → "I'm alive!" (ou équivalent)
curl -s -o /dev/null -w '%{http_code}\n' https://ai-api.linagora.com/key/list            # → 404
curl -s -o /dev/null -w '%{http_code}\n' https://ai-api.linagora.com/admin/ui/           # → 404
curl -s -o /dev/null -w '%{http_code}\n' https://ai-gateway.linagora.com/admin/ui/       # → 200 depuis une IP autorisée, 403 sinon
```
Vérifier dans les logs LiteLLM l'absence du message « Cannot apply server_root_path replacements to UI » (sinon l'UI sous `/admin` ne chargera pas ses assets : il faudra une image dérivée pré-traitée). Vérifier aussi qu'aucun port autre que 22/80/443 n'écoute publiquement : `ssh ia-host 'sudo ss -tlnp'` (Postgres ne doit **pas** être sur 0.0.0.0).

**Premiers modèles** (via l'UI admin `https://ai-gateway.linagora.com/admin/ui`, connexion locale `UI_USERNAME`/`UI_PASSWORD`), en suivant les exemples de `litellm/config.yaml` :
- un modèle OpenRouter N1 ou N2 ;
- le modèle N3 **Qwen3.8 sur l'endpoint OVHcloud** (`openai/<modèle>` + `api_base` = `OVH_QWEN_API_BASE`), après un test direct de l'endpoint (`curl <api_base>/models`).

Chaque modèle reçoit dans `model_info` : `input_cost_per_token` et `output_cost_per_token` **en EUR**, `pricing_currency: EUR` (et `fx_rate_usd_eur` pour les tarifs convertis), `data_level`, `hosting`.

**Test de bout en bout par l'API admin** (depuis le serveur, réseau interne, sans afficher la clé maître) :
```bash
ssh ia-host 'cd /opt/linagora-ia && MK=$(grep ^LITELLM_MASTER_KEY= .env | cut -d= -f2-) && \
  docker run --rm --network linagora-ia_default curlimages/curl -s -X POST http://litellm:4000/admin/team/new \
    -H "Authorization: Bearer $MK" -H "Content-Type: application/json" \
    -d "{\"team_alias\":\"test-install\",\"models\":[\"<modele-test>\"]}"'
```
Puis `/admin/key/generate` avec ce `team_id`, appel `https://ai-api.linagora.com/v1/chat/completions` (une fois avec le modèle OpenRouter, une fois avec Qwen3.8) avec la clé de test, vérification de la dépense (`/admin/key/info` : montant cohérent avec le tarif EUR), et **suppression** de la clé et de l'équipe de test (`/admin/key/delete`, `/admin/team/delete`).

## Phase 6 — SSO admin LiteLLM (🧑 LemonLDAP::NG)

🧑 L'utilisateur déclare dans LemonLDAP::NG les clients OIDC du PRD §4.3 (au minimum `litellm-admin` et `superset` ; `portail-ia` peut attendre la phase 9), avec **une règle d'accès limitant `litellm-admin` aux uid admins**, et renseigne les secrets dans `.env`.

L'agent vérifie les endpoints réels : `curl -s https://sso.linagora.com/.well-known/openid-configuration | jq '{authorization_endpoint, token_endpoint, userinfo_endpoint}'` et corrige les variables `GENERIC_*` si besoin. Consulter la doc LiteLLM « SSO for Admin UI » de la version déployée pour la désignation des admins (attribut de rôle ou `PROXY_ADMIN_ID`).

```bash
ssh ia-host 'cd /opt/linagora-ia && docker compose up -d litellm'
```
**Contrôle** : connexion à `https://ai-gateway.linagora.com/admin/ui` via « Login with SSO » (redirect URI `https://ai-gateway.linagora.com/admin/sso/callback`) avec un uid admin ; un uid non admin est refusé par LemonLDAP.

## Phase 7 — Reporting (Superset) et sauvegardes

1. Vues de reporting (après le 1er démarrage de LiteLLM) :
   ```bash
   ssh ia-host 'cd /opt/linagora-ia && docker compose exec -T postgres psql -U litellm -d litellm -v ON_ERROR_STOP=1 -f - < postgres/reporting_views.sql'
   ```
   Contrôle : `docker compose exec -T postgres psql -U reporting_ro -d litellm -c "select count(*) from v_requests"` fonctionne, et `select count(*) from \"LiteLLM_SpendLogs\"` est **refusé**.
2. Superset :
   ```bash
   ssh ia-host 'cd /opt/linagora-ia && docker compose build superset && \
     docker compose run --rm superset superset db upgrade && \
     docker compose run --rm superset superset fab create-admin --username "$(grep ^SUPERSET_ADMIN_UID= .env | cut -d= -f2)" \
        --firstname Admin --lastname IA --email admin-ia@linagora.com --password "$(openssl rand -hex 16)" && \
     docker compose run --rm superset superset init && docker compose up -d redis superset'
   ```
   Connexion OIDC sur `https://ai-gateway.linagora.com/stats/` avec l'uid admin. **Recette du sous-chemin** : pages, graphiques, exports CSV, liens de partage. Si les assets sont servis correctement sous `/stats/static/`, retirer `/static/*` du Caddyfile ; si le sous-chemin est trop instable dans la version retenue, 🧑 le signaler (repli possible : sous-domaine dédié). Ajouter la base « LiteLLM reporting » : `postgresql+psycopg2://reporting_ro:<REPORTING_RO_PASSWORD>@postgres:5432/litellm` (saisie par l'utilisateur dans l'UI, ou par l'agent via la CLI Superset sans afficher le mot de passe). Créer les datasets à partir des vues `reporting.*` (montants en €), le tableau de bord « Vue d'ensemble » (PRD §7.1) et un graphique de contrôle sur `v_check_pricing_eur` (doit rester vide).
   Autres lecteurs : les créer dans Superset (Paramètres → Utilisateurs) avec `username = uid`, rôle `Gamma` + accès aux datasets.
3. Sauvegardes :
   ```bash
   ssh ia-host '(sudo crontab -l 2>/dev/null; echo "30 2 * * * /opt/linagora-ia/scripts/backup.sh >> /var/log/linagora-ia-backup.log 2>&1") | sort -u | sudo crontab - && sudo /opt/linagora-ia/scripts/backup.sh'
   ```
   🧑 Copie hors instance : créer un conteneur OVH Object Storage + identifiants S3, configurer `rclone` et décommenter la ligne dans `backup.sh`.
   **Contrôle** : restaurer `litellm-*.dump` dans une base temporaire (`createdb restore_test && pg_restore -d restore_test …`), compter les lignes de `LiteLLM_VerificationToken`, supprimer la base de test (confirmation demandée).

## Phase 8 — Recette socle
Critères d'acceptation 1, 2, 3, 7, 9 du PRD §9. Mettre à jour `docs/INSTALL-LOG.md`.

## Phase 9 — Déploiement du portail (après développement, cf. PORTAL-BRIEF)

```bash
rsync -av --delete --exclude node_modules --exclude .next --exclude '.env*' portal/ ia-host:/opt/linagora-ia/portal/
ssh ia-host 'cd /opt/linagora-ia && docker compose --profile portal build portal && \
  docker compose --profile portal run --rm portal npx prisma migrate deploy && \
  docker compose --profile portal up -d portal'
```
**Contrôle** : critères 4, 5, 6, 8 du PRD §9.

## Phase 10 — Langfuse (phase 2, seconde instance recommandée)

- Nouvelle instance (B2-15 ou plus), phases 0 et 1 identiques, reliée à la première par le **réseau privé OVH (vRack)** ; aucun port Langfuse exposé publiquement (ufw : autoriser le port web uniquement depuis l'IP privée de la première instance).
- Accès via `https://ai-gateway.linagora.com/traces/` : Caddy (instance 1) relaie vers `LANGFUSE_UPSTREAM` (décommenter le bloc `/traces` du Caddyfile).
- **Construire l'image web** Langfuse avec `--build-arg NEXT_PUBLIC_BASE_PATH=/traces` (l'image précompilée ne gère pas de sous-chemin ; le worker peut rester l'image officielle), `NEXTAUTH_URL=https://ai-gateway.linagora.com/traces/api/auth`.
- Utiliser le `docker-compose.yml` **officiel** de Langfuse (dépôt `langfuse/langfuse`, tag épinglé), remplacer toutes les lignes `# CHANGEME`, ne publier que via un reverse proxy TLS.
- OIDC : variables `AUTH_CUSTOM_CLIENT_ID`, `AUTH_CUSTOM_CLIENT_SECRET`, `AUTH_CUSTOM_ISSUER`, `AUTH_CUSTOM_NAME=Linagora SSO` ; désactiver l'inscription par e-mail/mot de passe.
- Côté LiteLLM : décommenter le bloc Langfuse de `litellm/config.yaml`, ajouter `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` (adresse privée de Langfuse, avec le préfixe `/traces`) au service `litellm`, garder `turn_off_message_logging: true` sauf décision contraire.

---

## Mise à jour de LiteLLM
1. Lire les notes de version (changements de schéma, ruptures d'API).
2. `backup.sh`, puis vérification cosign du nouveau tag (phase 4).
3. Mettre à jour `LITELLM_IMAGE`, `docker compose up -d litellm`, contrôler les logs de migration Prisma.
4. Rejouer `reporting_views.sql` et vérifier les colonnes utilisées.
5. Contrôles de la phase 5.

## Dépannage rapide
- `docker compose logs -f <service>` ; `docker stats --no-stream` (mémoire : la B2-15 est juste).
- Certificat non émis : DNS non propagé ou port 80 bloqué → `docker compose logs caddy`.
- SSO en échec : comparer l'URI de redirection déclarée dans LemonLDAP avec celle du PRD §4.3 (schéma, domaine, chemin exacts, préfixes `/admin`, `/stats`, `/traces` compris).
- Session perdue en passant du portail à `/stats` ou `/admin` : collision de cookies sur le même domaine → vérifier les noms de cookies (Superset : `superset_session`).
