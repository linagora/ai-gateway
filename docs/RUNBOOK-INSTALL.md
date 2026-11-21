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

**Filtrage réseau OVHcloud (🧑)** : en amont du pare-feu du serveur (ufw), le groupe de sécurité OpenStack de l'instance filtre aussi le trafic. Dans Horizon (espace client OVHcloud → projet Public Cloud → « Horizon » ; région de l'instance), menu Network → Security Groups → groupe de l'instance → « Manage Rules » (gérer les règles) → « Add Rule » (ajouter une règle), en entrée (Ingress) depuis `0.0.0.0/0` : TCP 80 (règle HTTP), TCP 443 (HTTPS), UDP 443 (règle UDP personnalisée, pour HTTP/3). N'ajouter aucun autre groupe à l'instance, et garder SSH limité aux sorties VPN. Sans ces règles, Let's Encrypt échoue (« Timeout during connect »).

## Phase 3 — Déploiement des fichiers et secrets

```bash
rsync -av --exclude '.env' infra/ ia-host:/opt/linagora-ia/
ssh ia-host 'chmod +x /opt/linagora-ia/scripts/*.sh /opt/linagora-ia/postgres/init/*.sh && /opt/linagora-ia/scripts/gen-secrets.sh'
```
Le script liste les variables `__ASK__` restantes. L'agent renseigne celles qui ne sont pas secrètes (domaines, IP, uid, SMTP_HOST…) avec `sed -i` sur le serveur. Pour les **secrets fournis par l'utilisateur** (clé OpenRouter, `OVH_QWEN_API_BASE` / `OVH_QWEN_API_KEY`, `NOX_API_BASE` / `NOX_API_KEY`, `SCALEWAY_API_BASE` / `SCALEWAY_API_KEY`, secrets des clients OIDC, mot de passe SMTP) : 🧑 l'utilisateur les saisit lui-même, une variable à la fois, en saisie masquée (la valeur n'apparaît ni à l'écran, ni dans `ps`, ni dans l'historique) :
```bash
ssh -t ia-host '/opt/linagora-ia/scripts/set-env-var.sh OPENROUTER_API_KEY'
```
Autre possibilité : `ssh -t ia-host 'nano /opt/linagora-ia/.env'`, à condition que l'agent ne modifie pas le fichier au même moment.

`VLLM_SR_API_KEY` (d3-ultra, niveau Expérimental) n'est pas fournie par l'utilisateur : l'agent la crée sur le serveur, après l'accord de l'utilisateur, car la créer vaut acceptation des conditions d'utilisation de decision.vllm-sr.ai au nom de LINAGORA. Le script l'écrit dans `.env` sans l'afficher ; il garde une clé présente et active, et n'en crée qu'une à la fois :
```bash
ssh ia-host 'cd /opt/linagora-ia && python3 scripts/creer-cle-vllm-sr.py --accepter-les-conditions'
```

⚠️ Les variables du `.env` sont figées à la création d'un conteneur : après toute modification, recréer les services concernés (`docker compose up -d litellm`, par exemple), sinon ils gardent l'ancienne valeur.
**Contrôle** (sans afficher de valeur) : `ssh ia-host "grep -cE '^[A-Z0-9_]+=.*__(ASK|GENERATE)' /opt/linagora-ia/.env"` → `0` avant la phase 5 (les secrets OIDC peuvent attendre les phases 6 et 7 ; les laisser à `__ASK__` jusque-là).

## Phase 4 — Choix et vérification des versions

1. LiteLLM : identifier la dernière version stable **`vX.Y.Z`** sur `ghcr.io/berriai/litellm` (page Releases GitHub de BerriAI/litellm : release sans suffixe `-rc` / `-dev`, publiée depuis une branche `stable/X.Y.x` ; le suffixe `-stable` n'est plus utilisé depuis mai 2026). Installer cosign sur le serveur (binaire de release GitHub sigstore/cosign, vérifier la somme SHA256), puis :
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
# Fichiers audio de plus de 25 Mo (25 000 000 octets) refusés par Caddy. Corps en octet-stream : dans le type par défaut de
# curl (x-www-form-urlencoded), LiteLLM refuse un champ de plus de 1 Mo (400) avant que Caddy ne compte les 25 Mo.
head -c 25000001 /dev/zero | curl -s -o /dev/null -w '%{http_code}\n' -H 'Content-Type: application/octet-stream' \
  --data-binary @- https://ai-api.linagora.com/v1/audio/transcriptions                 # → 413
curl -s -o /dev/null -w '%{http_code}\n' https://ai-gateway.linagora.com/admin/ui/       # → 200 depuis une IP autorisée, 403 sinon
```
Vérifier dans les logs LiteLLM l'absence du message « Cannot apply server_root_path replacements to UI » (sinon l'UI sous `/admin` ne chargera pas ses assets : il faudra une image dérivée pré-traitée). Vérifier aussi qu'aucun port autre que 22/80/443 n'écoute publiquement : `ssh ia-host 'sudo ss -tlnp'` (Postgres ne doit **pas** être sur 0.0.0.0).

**Premiers modèles** :
- le modèle N3 **Qwen3.8 sur l'endpoint OVHcloud** (`openai/<modèle>` + `api_base` = `OVH_QWEN_API_BASE`), après un test direct de l'endpoint (`curl <api_base>/models`), par l'API ou l'UI admin (`https://ai-gateway.linagora.com/admin/ui`, connexion locale `UI_USERNAME`/`UI_PASSWORD`) ;
- les modèles **OpenRouter**, uniquement par la liste blanche (ci-dessous), jamais à la main ni par l'UI ;
- **Qwen3.8** (OVHcloud, N3), les trois modèles d'**embeddings** d'OVHcloud (`bge-m3`, `bge-multilingual-gemma2`, `qwen3-embedding-8b`, N3, avec l'adresse et la clé de Qwen3.8), **JEV** (Typesafe, niveau Expérimental, par l'API System One d'OpenRouter), **Nox-4B** (`nox-4b`, N3, même API que JEV, à 0 € sur une carte GPU de LINAGORA, par le LiteLLM de cette carte : route `openai/jev-latest`, adresse et clé dans `NOX_API_BASE` / `NOX_API_KEY`), **d3-ultra** (`d3-ultra`, niveau Expérimental, Decision 3.0 de vLLM Semantic Router, même API que JEV, à 0 € par l'accès gratuit de decision.vllm-sr.ai : route `vllm-sr/vllm-sr/d3-ultra`, clé dans `VLLM_SR_API_KEY`) et les modèles de **Scaleway** (niveau Expérimental pendant l'essai ; modèles de conversation, dont `qwen3.8-scaleway`, par la route `scaleway/<nom chez Scaleway>`, modèle d'embeddings `qwen3-embedding-8b-scaleway`, par la route `hosted_vllm/qwen3-embedding-8b`, modèle de transcription `whisper-large-v3`, par la route `scaleway/whisper-large-v3`, facturé à la durée de l'audio, et modèle d'OCR `lightonocr-3`, par la route `scaleway/lightonocr-3-0.8b`, appelé par les chat completions avec un seul PDF, sans consigne ; suffixe `-scaleway` quand la passerelle sert déjà le modèle sous ce nom, par OVHcloud ou OpenRouter ; adresse du projet dédié et clé de son application IAM dans `SCALEWAY_API_BASE` / `SCALEWAY_API_KEY`), hors de la liste blanche : `docker compose exec -T litellm python3 - < scripts/declare-modeles-directs.py` (déclare le modèle s'il manque, sinon réécrit ses informations — fournisseur, éditeur, capacités, hébergeurs, zone — ainsi que sa route, son adresse et sa clé ; les tarifs restent inchangés). Les embeddings passent par la route `hosted_vllm/` : dans la 1.102.1, c'est la seule qui transmet `encoding_format`, envoyé par défaut par les SDK OpenAI, et `dimensions` ; la route `ovhcloud/` refuse tout paramètre des embeddings, la route `openai/` refuse `dimensions`, la route `scaleway/` ne fait pas d'embeddings. La route `scaleway/` retire de la requête les outils d'un modèle qui ne déclare pas `supports_function_calling`, et `reasoning_effort` d'un modèle qui ne déclare pas `supports_reasoning` ; elle répond 500 à un paramètre d'échantillonnage hors OpenAI, comme `top_k` (1.102.1) : la déclaration des modèles de Scaleway donne ces deux champs et écarte ces paramètres.

**Liste blanche OpenRouter** (`litellm/liste-blanche-openrouter.yaml`, versionnée) : seuls ses modèles sont déclarés ; aucun joker (`openrouter/*`). Chaque modèle a une **zone d'exécution** : `UE` (points d'accès `mistral/eu`, `google-vertex/eu`, Inceptron, NextBit) ou `monde` (fournisseurs au siège américain, sans conservation des données). Le routage d'OpenRouter est limité à ces points d'accès (`provider.only`), avec repli de l'un à l'autre quand le premier choisi est saturé ou en panne (`allow_fallbacks: true` ; le repli ne sort pas de `provider.only`, vérifié le 2026-10-31). Prix déclarés en € = prix OpenRouter le plus élevé de la zone × 1,055 (frais d'achat de crédits) × taux BCE ; plafond facultatif `prix_max_usd` transmis à OpenRouter ; `exclus`, facultatif, écarte des fournisseurs de la zone pour un modèle. Un modèle qui cherche sur le web à chaque requête (Perplexity Sonar) déclare en plus le prix d'une recherche selon sa profondeur (`recherche_usd` : OpenRouter ne publie que celui de la profondeur par défaut), que LiteLLM ajoute à chaque réponse qui cite ses sources ; sa déclaration donne la profondeur par défaut (`web_search_options`), que la garde applique aux requêtes qui n'en demandent pas, car LiteLLM compterait la profondeur moyenne.
```bash
cd /opt/linagora-ia
docker compose exec -T litellm python3 - < scripts/sync-openrouter.py               # plan et écarts (code 1 s'il en reste)
docker compose exec -T litellm python3 - --appliquer < scripts/sync-openrouter.py   # création / mise à jour
docker compose exec -T litellm python3 - < scripts/test-liste-blanche.py            # recette (98 contrôles pour 21 modèles au 2026-10-15, selon la liste ; < 0,01 €)
```
- Les modèles OpenRouter sont joints en `openai/<id>` sur `https://openrouter.ai/api/v1`, **pas** par la route `openrouter/` de LiteLLM : celle-ci enregistre le coût renvoyé par OpenRouter, **en dollars**, à la place des tarifs en euros (vérifié sur la 1.102.1).
- Un modèle OpenRouter hors liste est signalé par `sync-openrouter.py` ; `--supprimer-hors-liste` le supprime.
- La **garde** (`litellm/garde.py`, chargée par `litellm_settings.callbacks`) refuse les paramètres qui changeraient de modèle ou de fournisseur : `models`, `route`, `provider`, `plugins`, `preset`, `usage`, `extra_body`, `additional_drop_params`, `fallbacks`… Sans elle, une requête pourrait nommer un modèle de repli hors liste ou un fournisseur hors zone : ses paramètres priment sur ceux du modèle. Pour un modèle qui cherche sur le web à chaque requête, elle complète la requête de la profondeur déclarée et l'inscrit au calcul du coût (LiteLLM le prépare avant de choisir le modèle et n'y verrait pas sa déclaration) ; elle refuse pour lui `/v1/messages` et `/v1/responses`, où LiteLLM ne compte pas la recherche : il s'appelle par `/v1/chat/completions`. Avant une transcription, elle lit la durée du fichier comme LiteLLM la lira (bibliothèque soundfile) et refuse (400) un fichier dont la durée est illisible, que LiteLLM compterait à 0 € : dans l'image amd64 de la 1.102.1 (le serveur), WAV, FLAC, MP3, OGG (Vorbis, Opus) et AIFF passent, M4A, MP4 et WebM non ; son message n'annonce que WAV, FLAC, MP3 et OGG Opus, transcrits aussi par Scaleway (OGG Vorbis n'y a pas été essayé, l'AIFF est absent de sa liste). L'image arm64 (postes Mac), sous le même digest, ne lit pas non plus le MP3 (libsndfile du système, compilée sans MP3) : un essai local de transcription en MP3 y est refusé. La garde est chargée au démarrage : après une modification, redémarrer LiteLLM (`docker compose restart litellm`, une quarantaine de secondes d'indisponibilité).
- Revoir le taux et les prix chaque trimestre (modifier `taux_usd_eur`, puis `--appliquer`).

**JEV** : fournisseur personnalisé (`litellm/jev.py`, `litellm_settings.custom_provider_map`), modèle `jev-latest`, appelé comme tout modèle par `/v1/chat/completions`. Le dernier message contient la requête System One de Typesafe en JSON (`{"state": …, "questions": {…}}`), la réponse est le JSON des réponses ; seuls l'état et les questions sont transmis. Typesafe n'ouvrant plus de compte, `jev.py` appelle l'API System One d'OpenRouter (`https://openrouter.ai/api/v1/systemone`, alias `~typesafe/jev-latest`, clé OpenRouter), au même prix (0,042 $ par million de jetons d'entrée, sortie gratuite). Coût sur les jetons comptés par Typesafe. Une route dédiée (« pass-through ») n'est pas possible : ouvrir une telle route à une clé (`allowed_passthrough_routes`) est réservé à l'édition Enterprise. `sync-openrouter.py` ne compte pas JEV parmi les modèles de conversation de la liste blanche.

**d3-ultra** : même fournisseur personnalisé, sous le nom `vllm-sr`, et même convention d'appel que JEV. `jev.py` appelle l'API System One de vLLM Semantic Router (`https://decision.vllm-sr.ai/v1/systemone`, modèle `vllm-sr/d3-ultra`, le plus performant que sert l'accès gratuit, à 0 €). Le service conserve requêtes et réponses et peut s'en servir pour entraîner ses modèles : niveau Expérimental, données publiques uniquement. Ses limites (`https://decision.vllm-sr.ai/api/info`) valent pour toute la passerelle, qui n'a qu'une clé : 540 requêtes et 450 000 jetons par minute pour d3-ultra au 2026-11-02, 35 s par requête.

Chaque modèle reçoit :
- dans **`litellm_params`** : `input_cost_per_token` et `output_cost_per_token` **en EUR**. Depuis LiteLLM 1.10x, les prix placés dans `model_info` sont considérés comme dérivés de la table de coûts publique et **supprimés à l'enregistrement** ; `/model/info` les recopie ensuite dans `model_info` pour l'affichage ;
- dans **`model_info`** : `pricing_currency: EUR` (et `fx_rate_usd_eur` pour les tarifs convertis), `data_level` (`N1`, `N2`, `N3`, ou `EXP` pour un modèle en bêta), `hosting`.

Déclaration possible par l'API (exemple : `scripts/smoke-test.py` pour le test, `POST /model/new` pour la création). Test de bout en bout réutilisable : `docker compose exec -T litellm python3 - <model_name> < scripts/smoke-test.py` (équipe et clé de test, critère 1, complétion, dépense au tarif EUR hors flux et en flux, prix des jetons lus depuis le cache, `/v1/messages`, `/v1/messages` tel que l'envoie Claude Code (en flux : événements SSE et dépense enregistrée sur la clé ; sans flux : appel d'outil), révocation → 401, nettoyage ; pour un modèle d'embeddings, `/v1/embeddings` à la place de la complétion : taille et format des vecteurs (base64 demandé : des chaînes ; sans format : des nombres), taille réduite demandée en base64 tenue ou refusée, dépense au prix d'entrée ; pour un modèle de transcription, un extrait parlé (`litellm/recette/extrait.ogg`, voix de synthèse) : texte, dépense égale à sa durée multipliée par le prix par seconde, puis un M4A refusé par la garde ; pour un modèle d'OCR, un PDF d'une ligne (`litellm/recette/ligne.pdf`) : texte de la ligne, dépense au prix d'entrée). Il sort en erreur si un contrôle échoue.

**Test de bout en bout par l'API admin** (depuis le serveur, réseau interne, sans afficher la clé maître) :
```bash
ssh ia-host 'cd /opt/linagora-ia && MK=$(grep ^LITELLM_MASTER_KEY= .env | cut -d= -f2-) && \
  docker run --rm --network linagora-ia_default curlimages/curl -s -X POST http://litellm:4000/admin/team/new \
    -H "Authorization: Bearer $MK" -H "Content-Type: application/json" \
    -d "{\"team_alias\":\"test-install\",\"models\":[\"<modele-test>\"]}"'
```
Puis `/admin/key/generate` avec ce `team_id`, appel `https://ai-api.linagora.com/v1/chat/completions` (une fois avec le modèle OpenRouter, une fois avec Qwen3.8) avec la clé de test, vérification de la dépense (`/admin/key/info` : montant cohérent avec le tarif EUR), et **suppression** de la clé et de l'équipe de test (`/admin/key/delete`, `/admin/team/delete`).

## Phase 6 — SSO : client OIDC unique et point de contrôle (🧑 LemonLDAP::NG)

Un seul client OIDC, celui du portail (PRD §4.3). `/admin` et `/stats` sont protégés par le point de contrôle du portail (`caddy/portal-gate.caddy`), avec les listes `PORTAL_ADMIN_UIDS` et `PORTAL_REPORTING_UIDS` du `.env`. Ni LiteLLM ni Superset n'ont de SSO propre.

🧑 L'utilisateur fait déclarer le client `portail-ia` : redirect URI `https://ai-gateway.linagora.com/api/auth/callback/lemonldap`, tous les salariés, scopes `openid profile email`, claims `sub` (= uid), `email` et `name` dans l'ID token, PKCE S256. Il saisit ensuite le secret : `ssh -t ia-host '/opt/linagora-ia/scripts/set-env-var.sh OIDC_CLIENT_SECRET'`.

L'agent vérifie l'issuer : `curl -s https://sso.linagora.com/.well-known/openid-configuration | jq '{issuer, authorization_endpoint, code_challenge_methods_supported}'`.

⚠️ Tant que le portail n'est pas déployé (phase 9), `/admin` et `/stats` répondent 502 (fermeture par défaut). Accès de secours à la console LiteLLM par un tunnel SSH :
```bash
IP=$(ssh ia-host "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' linagora-ia-litellm-1")
ssh -N -L 14000:$IP:4000 ia-host    # puis http://localhost:14000/admin/ui (compte UI_USERNAME / UI_PASSWORD)
```
Mot de passe de la console : `ssh -t ia-host '/opt/linagora-ia/scripts/set-env-var.sh UI_PASSWORD'`, puis `docker compose up -d litellm`.

**Contrôle** (après la phase 9) : un admin atteint `https://ai-gateway.linagora.com/admin/ui` puis se connecte avec le compte local ; un salarié non admin reçoit 403 ; un lecteur listé dans `PORTAL_REPORTING_UIDS` atteint `/stats/` ; sans session, les deux renvoient vers la connexion SSO du portail. Le même fragment Caddy est testé automatiquement : `portal/e2e/point-de-controle.spec.ts`.

## Phase 7 — Reporting (Superset) et sauvegardes

1. Vues de reporting (après le 1er démarrage de LiteLLM) :
   ```bash
   ssh ia-host 'cd /opt/linagora-ia && docker compose exec -T postgres psql -U litellm -d litellm -v ON_ERROR_STOP=1 -f - < postgres/reporting_views.sql'
   ```
   Contrôle : `docker compose exec -T postgres psql -U reporting_ro -d litellm -c "select count(*) from v_requests"` fonctionne, et `select count(*) from public.\"LiteLLM_SpendLogs\"` est **refusé** (« permission denied » ; préciser le schéma `public`, sinon l'erreur est « does not exist » car le `search_path` de `reporting_ro` se limite à `reporting`).
   Abonnements (ADR 0002), une fois les migrations du portail appliquées : lien entre bases, idempotent, à relancer après une migration du portail qui touche ses vues de reporting :
   ```bash
   ssh ia-host 'cd /opt/linagora-ia && sudo scripts/installer-lien-portail.sh'
   ```
   Le script génère `PORTAL_REPORTING_RO_PASSWORD` dans le `.env` s'il manque (jamais affiché), crée le rôle `portal_reporting_ro` (lecture seule du schéma `reporting` de la base `portal`), les vues du portail (`postgres/portal_reporting_views.sql`), le serveur `postgres_fdw` « portail » (connexion TCP au service `postgres`, authentifiée par mot de passe ; la correspondance d'utilisateur de `litellm` porte ce mot de passe, qui figure donc dans les sauvegardes de la base `litellm`), puis les tables étrangères (schéma `portail`, que `reporting_ro` ne lit pas) et les vues des abonnements du schéma `reporting` (`postgres/reporting_abonnements.sql`). Il finit par ses contrôles : lectures des vues, refus des tables étrangères, des tables brutes du portail et de l'écriture.
2. Superset :
   ```bash
   ssh ia-host 'cd /opt/linagora-ia && docker compose build superset && \
     docker compose run --rm superset superset db upgrade && \
     docker compose run --rm superset superset fab create-admin --username "$(grep ^SUPERSET_ADMIN_UID= .env | cut -d= -f2)" \
        --firstname Admin --lastname IA --email admin-ia@linagora.com --password "$(openssl rand -hex 16)" && \
     docker compose run --rm superset superset init && docker compose up -d redis superset'
   ```
   Connexion par le point de contrôle du portail (après la phase 9) sur `https://ai-gateway.linagora.com/stats/`. **Recette du sous-chemin** : pages, graphiques, exports CSV, liens de partage. Si les assets sont servis correctement sous `/stats/static/`, retirer `/static/*` du Caddyfile ; si le sous-chemin est trop instable dans la version retenue, 🧑 le signaler (repli possible : sous-domaine dédié). Ajouter la base « LiteLLM reporting » : `postgresql+psycopg2://reporting_ro:<REPORTING_RO_PASSWORD>@postgres:5432/litellm` (saisie par l'utilisateur dans l'UI, ou par l'agent via la CLI Superset sans afficher le mot de passe). Script prêt : `superset/init-reporting.py` (connexion + un jeu de données par vue, idempotent ; le mot de passe passe par l'entrée standard, voir l'en-tête du script). Puis les tableaux de bord, versionnés et reconstruits à l'identique :
   ```bash
   docker compose exec -T superset python3 - < superset/tableaux-de-bord.py
   ```
   - **Consommation** (admins et lecteurs du reporting) : indicateurs comparés à la période précédente (coût, requêtes, jetons), taux de réussite, équipes et clés actives, vue d'ensemble par jour, modèles, fournisseurs et hébergements, consommation et budget par équipe, niveaux déclarés des clés.
   - **Pilotage** (admins) : plus gros consommateurs, clés les plus utilisées, clés à 80 % de leur budget ou plus, clés sans utilisation depuis 30 jours, qualité de service (taux d'erreur, latences moyenne et p95) par modèle et par fournisseur, contrôle devise (doit rester à 0).
   - **Par salarié** (admins) : pour le salarié choisi dans le filtre obligatoire « Salarié (uid) », dépense de la passerelle comparée à la période précédente, par jour, par modèle, par niveau déclaré et par clé, et ses clés (statut, part du budget consommée, expiration) ; ses abonnements (offre, montant, dates, statut, adresse hors LINAGORA) et son coût mensuel sur douze mois. Suivi nominatif : les salariés en ont été informés.
   - **Abonnements** dans « Consommation » : abonnements en cours par équipe, fournisseur et offre, avec leur coût mensuel ; coût mensuel sur douze mois et coût du mois en cours par équipe. La passerelle est en € HT (tarifs des fournisseurs), les abonnements en € TTC (prélèvements déclarés).
   - Période par défaut : les 30 derniers jours, aujourd'hui compris ; filtres Équipe et Niveau sur « Consommation ».
   - Le rôle « Lecteur reporting » n'accède qu'aux vues agrégées (`v_usage_daily`, `v_team_budget`, `v_activity`, `v_team_subscriptions`, `v_team_monthly_cost`) ; l'accès aux tableaux est réglé par rôle (`DASHBOARD_RBAC`). L'indicateur comparé à la période précédente (`pop_kpi`) exige `CHART_PLUGINS_EXPERIMENTAL`.
   Autres lecteurs : ajouter leur uid à `PORTAL_REPORTING_UIDS` dans le `.env`, puis `docker compose --profile portal up -d portal`. Leur compte Superset est créé à la première visite, avec le rôle « Lecteur reporting » (créé par `superset/init-reporting.py`).
3. Sauvegardes :
   ```bash
   ssh ia-host '(sudo crontab -l 2>/dev/null; echo "30 2 * * * /opt/linagora-ia/scripts/backup.sh >> /var/log/linagora-ia-backup.log 2>&1") | sort -u | sudo crontab - && sudo /opt/linagora-ia/scripts/backup.sh'
   ```
   🧑 Copie hors instance : créer un conteneur OVH Object Storage + identifiants S3, configurer `rclone` et décommenter la ligne dans `backup.sh`.
   **Contrôle** : `ssh ia-host 'sudo /opt/linagora-ia/scripts/restore-test.sh'` — restaure la dernière sauvegarde (rôles + base `litellm`) dans un conteneur Postgres jetable et sans réseau, affiche les volumes à côté de ceux de la production, vérifie les vues de reporting avec `reporting_ro`, puis supprime le conteneur. Le Postgres de production n'est jamais touché (aucune base de test à supprimer). Note : les images cloud Debian 13 n'ont pas `cron` ; `bootstrap-host.sh` l'installe.

## Phase 8 — Recette socle
Critères d'acceptation 1, 2, 3, 7, 9 du PRD §9, par les URL publiques. Mettre à jour `docs/INSTALL-LOG.md`.
- Critère 3 depuis une IP non autorisée : lancer `curl` depuis le serveur lui-même (son IP publique n'est pas dans `ADMIN_ALLOWED_IPS`) → 403.
- Critères 1 et 7 avec une clé de test créée et utilisée **sur le serveur** (jamais affichée), contre `https://ai-api.linagora.com`. Une clé révoquée est refusée en 5 s au plus (`general_settings.user_api_key_cache_ttl: 5` ; sans ce réglage, 10 à 30 s).
- Liste blanche OpenRouter, garde et JEV : `scripts/test-liste-blanche.py` (voir la phase 5).

## Phase 9 — Déploiement du portail (après développement, cf. PORTAL-BRIEF)

**Version déployée** : toujours une version publiée (tag `vX.Y.Z`, voir « Releases » dans `CONTRIBUTING.md`), synchronisée depuis une copie du dépôt à ce tag, jamais depuis une copie de travail ; `infra/` aussi, quand la version le modifie. `docs/INSTALL-LOG.md` donne la version de chaque mise en production.

```bash
git fetch --tags origin && git worktree add --detach ../ai-gateway-vX.Y.Z vX.Y.Z && cd ../ai-gateway-vX.Y.Z
rsync -av --delete --exclude node_modules --exclude .next --exclude '.env*' portal/ ia-host:/opt/linagora-ia/portal/
ssh ia-host 'cd /opt/linagora-ia && docker compose --profile portal build portal portal-migrate && \
  docker compose --profile portal run --rm portal-migrate && \
  docker compose --profile portal up -d portal'
cd - && git worktree remove ../ai-gateway-vX.Y.Z
```
**Contrôle** : critères 4, 5, 6, 8 du PRD §9, puis contrôles du point de contrôle (phase 6), qui devient actif avec le portail. Le pied de page du portail, pour une personne connectée, donne la version déployée.

**Courriels** (spécification #14) : le portail envoie ses notifications et ses rappels, bilingues, par le serveur SMTP de `.env`. Sans `SMTP_HOST` ou sans `SMTP_FROM`, il n'envoie rien et tout le reste fonctionne ; un échec d'envoi est journalisé sans bloquer l'action.
- 🧑 Valeurs à fournir : `SMTP_HOST`, `SMTP_PORT` (465 : TLS implicite ; 587 : STARTTLS), `SMTP_USER`, `SMTP_FROM` (ex. `Portail IA Linagora <portail-ia@linagora.com>`), `ADMIN_NOTIFICATION_EMAILS` (admins à notifier, séparés par des virgules). L'agent les renseigne avec `sed -i` sur le serveur.
- 🧑 Le mot de passe est saisi par l'utilisateur lui-même, en masqué : `ssh -t ia-host '/opt/linagora-ia/scripts/set-env-var.sh SMTP_PASSWORD'`.
- Prise en compte : `docker compose --profile portal up -d portal` (recrée le conteneur avec les nouvelles variables).
- **Contrôle** : `docker compose exec -T portal env | ./scripts/verifier-smtp.py` (connexion et authentification avec la configuration reçue par le portail, sans envoi ni affichage de secret) ; puis déposer une demande de test : les admins reçoivent « Nouvelle demande de clé d'API / New API key request ». Sinon : `docker compose logs portal | grep "Courriel non envoyé"`.

**Tâche quotidienne** (rappels de retrait à J-3 ; rappels d'expiration un mois, sept jours et la veille, selon la durée de la clé ; expirations) : route interne `POST /api/taches/quotidienne` du portail, protégée par `PORTAL_TASK_TOKEN` et bloquée par Caddy depuis Internet ; le cron du serveur l'appelle chaque jour à 7 h, heure de Paris.
```bash
rsync -av --exclude '.env' infra/ ia-host:/opt/linagora-ia/
ssh ia-host 'sudo /opt/linagora-ia/scripts/installer-tache-quotidienne.sh && \
  cd /opt/linagora-ia && docker compose --profile portal up -d portal && docker compose restart caddy'
```
**Contrôle** : `curl -s -o /dev/null -w '%{http_code}' -X POST https://ai-gateway.linagora.com/api/taches/quotidienne` → 404 ; passage manuel depuis le serveur (même commande que le cron, dans `/etc/cron.d/linagora-ia-portail`) → compte rendu JSON ; journal : `/opt/linagora-ia/logs/taches.log`.
**Supervision des modèles** (planifiée dans le portail, sans cron : toutes les `SUPERVISION_INTERVAL_MINUTES` minutes, 10 par défaut, 0 la désactive ; après un changement, recréer le portail) : au démarrage, `docker compose logs portal` affiche « Supervision des modèles : sonde automatique toutes les 10 min », puis seulement les pannes et les passages en échec ; l'onglet **Gestion › Supervision** montre l'état de chaque modèle. Passage manuel depuis le serveur : `docker compose exec -T portal node -e "fetch('http://127.0.0.1:3000/api/taches/supervision',{method:'POST',headers:{authorization:'Bearer '+process.env.PORTAL_TASK_TOKEN}}).then(async r=>console.log(r.status,await r.text()))"` → compte rendu JSON, HTTP 503 si au moins un modèle est en panne confirmée (deux échecs consécutifs), 200 sinon, modèles dégradés compris ; depuis Internet, cette route répond 404. Les admins (`ADMIN_NOTIFICATION_EMAILS`) reçoivent un courriel après deux échecs consécutifs d'un modèle, puis à son rétablissement. Les sondes passent par la clé maître : leur coût (quelques jetons par modèle et par passage) compte dans les coûts mensuels de la passerelle, hors équipe, mais pas dans les tableaux de bord de consommation et de qualité de service de Superset, qui ne comptent que les appels des clés émises (vues de `postgres/reporting_views.sql`, à rejouer lors de la mise en ligne de la supervision).

## Phase 10 — Langfuse (phase 2, seconde instance recommandée)

- Nouvelle instance (B2-15 ou plus), phases 0 et 1 identiques, reliée à la première par le **réseau privé OVH (vRack)** ; aucun port Langfuse exposé publiquement (ufw : autoriser le port web uniquement depuis l'IP privée de la première instance).
- Accès via `https://ai-gateway.linagora.com/traces/` : Caddy (instance 1) relaie vers `LANGFUSE_UPSTREAM` (décommenter le bloc `/traces` du Caddyfile).
- **Construire l'image web** Langfuse avec `--build-arg NEXT_PUBLIC_BASE_PATH=/traces` (l'image précompilée ne gère pas de sous-chemin ; le worker peut rester l'image officielle), `NEXTAUTH_URL=https://ai-gateway.linagora.com/traces/api/auth`.
- Utiliser le `docker-compose.yml` **officiel** de Langfuse (dépôt `langfuse/langfuse`, tag épinglé), remplacer toutes les lignes `# CHANGEME`, ne publier que via un reverse proxy TLS.
- OIDC : variables `AUTH_CUSTOM_CLIENT_ID`, `AUTH_CUSTOM_CLIENT_SECRET`, `AUTH_CUSTOM_ISSUER`, `AUTH_CUSTOM_NAME=Linagora SSO` ; désactiver l'inscription par e-mail/mot de passe.
- Côté LiteLLM : décommenter le bloc Langfuse de `litellm/config.yaml`, ajouter `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` (adresse privée de Langfuse, avec le préfixe `/traces`) au service `litellm`, garder `turn_off_message_logging: true` sauf décision contraire.

---

## Mise à jour majeure de PostgreSQL (16.15 → 18.6 le 2026-09-26)
Les fichiers de données d'une version majeure ne servent pas à la suivante : la montée se fait par export et réimport, avec un court arrêt des services. Depuis la version 18, l'image officielle range les données sous `/var/lib/postgresql/18/docker` et le volume se monte sur `/var/lib/postgresql` : la migration crée un nouveau volume, et l'ancien reste intact pour un retour arrière.
1. Répéter en développement (`portal/dev/docker-compose.yml`), puis Vitest et Playwright.
2. `rsync` de `infra/` (nouveau montage dans `docker-compose.yml`, `scripts/migrer-postgres.sh`) ; nouvelle image dans le `.env` (`printf '%s' 'postgres:<version>@sha256:<empreinte>' | scripts/set-env-var.sh POSTGRES_IMAGE`), puis `docker compose pull postgres` : le serveur en service n'est pas touché.
3. Migration :
   ```bash
   ssh ia-host 'cd /opt/linagora-ia && scripts/migrer-postgres.sh'
   ```
   Le script arrête `portal`, `litellm` et `superset`, compte les lignes de chaque table, exporte tout (`backups/postgres-dumpall-<date>.sql`, droits 600), recrée le conteneur `postgres` sur le nouveau volume, réimporte l'export dans un conteneur temporaire sans réseau ni scripts d'initialisation, démarre le nouveau serveur et compare les lignes table par table. Les services restent arrêtés.
4. Contrôles, puis `docker compose --profile portal up -d` : portail, test de fumée de LiteLLM (phase 5), `scripts/installer-lien-portail.sh` (contrôles du lien entre bases), tableaux de bord Superset.
5. Retour arrière, tant que l'ancien volume existe : remettre l'ancienne image dans le `.env` et l'ancien montage (`pg_data:/var/lib/postgresql/data`) dans `docker-compose.yml`, puis `docker compose up -d postgres` ; les écritures faites depuis la migration sont perdues. L'ancien volume (`linagora-ia_pg_data`) ne se supprime qu'après validation, sur décision explicite.

## Mise à jour de LiteLLM
1. Lire les notes de version (changements de schéma, ruptures d'API).
2. `backup.sh`, puis vérification cosign du nouveau tag (phase 4).
3. Mettre à jour `LITELLM_IMAGE`, `docker compose up -d litellm`, contrôler les logs de migration Prisma.
4. Rejouer `reporting_views.sql` et vérifier les colonnes utilisées ; puis `scripts/installer-lien-portail.sh`, qui recrée les vues des abonnements.
5. Contrôles de la phase 5.

## Modèles de Scaleway
Modèles de Scaleway Generative APIs, en serverless (spécification #204). Ils sont appelés dans le projet dédié à la passerelle, avec la clé d'une application IAM limitée aux Generative APIs de ce projet. `declare-modeles-directs.py` les déclare (phase 5), au niveau Expérimental pendant l'essai. L'identifiant du projet et la clé ne sont que dans le `.env` du serveur.

Les nouveautés de cette section se publient dans Gestion › Nouveautés, catégorie « Modèles », en français et en anglais. 🧑 L'agent les rédige, l'utilisateur les valide avant publication. « Publier » montre aussitôt la nouveauté à tous les collaborateurs, sans date programmée ; publiée, elle se corrige (sans redevenir non lue) ou se supprime. Chaque opération de cette section se consigne dans `docs/INSTALL-LOG.md`.

**Variables** : `SCALEWAY_API_BASE`, l'adresse du projet (`https://api.scaleway.ai/<identifiant du projet>/v1`), et `SCALEWAY_API_KEY`, la clé secrète de l'application IAM.
1. `set-env-var.sh` ne renseigne qu'une variable déjà présente dans `.env`. Un `.env` plus ancien que ces variables les reçoit d'abord, à `__ASK__` comme dans `.env.example` :
   ```bash
   ssh ia-host 'cd /opt/linagora-ia && for v in SCALEWAY_API_BASE SCALEWAY_API_KEY; do grep -q "^$v=" .env || echo "$v=__ASK__" >> .env; done'
   ```
2. 🧑 L'utilisateur les saisit en masqué :
   ```bash
   ssh -t ia-host '/opt/linagora-ia/scripts/set-env-var.sh SCALEWAY_API_BASE'
   ssh -t ia-host '/opt/linagora-ia/scripts/set-env-var.sh SCALEWAY_API_KEY'
   ```
   Une clé créée par la CLI de Scaleway passe au serveur sans s'afficher : `scw iam api-key create application-id=<application> description=<usage> -o json | jq -r .secret_key | ssh ia-host '/opt/linagora-ia/scripts/set-env-var.sh SCALEWAY_API_KEY'`. Scaleway ne montre la partie secrète qu'à la création : si le flux échoue, supprimer cette clé (`scw iam api-key list bearer-id=<application>`, puis `scw iam api-key delete <clé d'accès>`) et recommencer.
3. LiteLLM ne lit ces variables qu'à sa recréation : `docker compose up -d litellm`, une quarantaine de secondes d'indisponibilité (`restart` ne relit pas `.env`).

**Contrôle**, sans afficher de valeur : `ssh ia-host "grep -cE '^SCALEWAY_API_(BASE|KEY)=.' /opt/linagora-ia/.env; grep -c '^SCALEWAY_API_.*__ASK__' /opt/linagora-ia/.env"` répond `2`, puis `0`. Après la recréation, `lire-quotas-scaleway.py` (« Quotas », plus bas) répond « • <nom> : HTTP 200 ».

**Journal des modifications et fins de vie** : Scaleway annonce ses nouveaux modèles et ses changements dans son journal des modifications. Le flux RSS est commun à tous ses produits : `https://www.scaleway.com/en/docs/changelog/rss.xml`. Le titre des entrées des Generative APIs commence par « Generative-apis | ». 🧑 L'administrateur s'abonne au flux, filtré sur ces titres. Relevé depuis le poste, dix dernières entrées :
```bash
curl -s https://www.scaleway.com/en/docs/changelog/rss.xml | python3 -I -c '
import sys, xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime as date
entrees = [i for i in ET.parse(sys.stdin).getroot().iter("item") if i.findtext("title", "").startswith("Generative-apis")]
for i in sorted(entrees, key=lambda i: date(i.findtext("pubDate")), reverse=True)[:10]:
    print(date(i.findtext("pubDate")).date(), i.findtext("title"))'
```
Une fin de vie y paraît sous « Deprecation » ou « … is now deprecated », mais le flux ne les annonce pas toutes : au 2026-11-21, ni celle de `holo2-30b-a3b` (dépréciation le 9 juillet 2026, fin de vie le 9 août) ni celle de `glm-5.2` (16 octobre, 16 novembre) n'y figurent. Le tableau « End of Life (EOL) models » de la page « Supported models » de Scaleway fait foi : date de dépréciation, date de fin de vie (« EOL date ») et modèle qui reçoit ensuite les requêtes. 🧑 L'administrateur le relit chaque semaine, depuis le poste, par la source de la page, publique sur GitHub :
```bash
curl -s https://raw.githubusercontent.com/scaleway/docs-content/main/pages/generative-apis/reference-content/supported-models.mdx | \
  awk '/End of Life/ && !fin {f = 1} f && /^\|/ {print; t = 1; next} t {f = 0; fin = 1}' | grep -v '^|[-|: ]*$'
```
Scaleway promet un préavis de trois mois pour un modèle Active et d'un mois pour un modèle en Preview : un relevé par semaine laisse au moins trois semaines. Exemple : `gemma-3-27b-it`, déprécié le 1er juillet 2026, a pris fin le 1er août ; ses requêtes vont depuis à `gemma-4-26b-a4b-it`. Après la fin de vie, la passerelle servirait donc un autre modèle sous le même nom, ou des erreurs pour un modèle sans successeur : d'où le retrait la veille.

**Fin de service d'un modèle annoncée par Scaleway**, même avec moins d'un mois de préavis. La date qui compte est la fin de vie (« EOL date ») : le modèle est retiré la veille.
1. Le jour de l'annonce, ou du relevé qui la découvre quand le flux l'omet, 🧑 une nouveauté : modèle retiré, date du retrait et remplaçant, s'il y en a un.
2. Un remplaçant entre sous son propre nom, comme tout nouveau modèle : déclaration, recette, fiche, niveau Expérimental puis sortie de l'essai. Les clés existantes ne l'incluent pas, car les modèles d'une clé sont fixés à sa création.
3. Avant la veille, une version publiée retire le modèle de `declare-modeles-directs.py`, sinon le script le redéclarerait. Elle est mise en production (phase 9, `infra/` compris).
4. La veille de la fin de vie :
   1. 🧑 l'admin masque d'abord la fiche : Gestion › Catalogue, décocher « Visible des collaborateurs », Enregistrer. Après la suppression, Gestion › Catalogue ne montre plus le modèle, et la supervision compterait en panne un modèle absent dont la fiche est visible (courriel aux admins, incident sur l'état des services) ;
   2. le script liste ce qu'il supprimerait (« • <nom> : route …, source …, niveau …, id … », puis « Rien n'est supprimé… ») :
      ```bash
      ssh ia-host 'cd /opt/linagora-ia && docker compose exec -T litellm python3 - <nom> < scripts/supprimer-modele-direct.py'
      ```
   3. 🧑 confirmation explicite de l'utilisateur ;
   4. suppression (« ✔ <nom> : supprimé de LiteLLM… ») ; le second processus de LiteLLM sert encore le modèle 30 s au plus :
      ```bash
      ssh ia-host 'cd /opt/linagora-ia && docker compose exec -T litellm python3 - <nom> --supprimer < scripts/supprimer-modele-direct.py'
      ```

   Le script refuse un modèle de la liste blanche OpenRouter : celui-ci se supprime par `sync-openrouter.py --supprimer-hors-liste`, une fois retiré de la liste. **Contrôle** : la commande du 2, rejouée, répond « ✘ <nom> : absent de LiteLLM… » ; Gestion › Catalogue ne montre plus le modèle.

**Reprise d'un nom par la version de Scaleway** : le cas se présente quand la version OpenRouter d'un modèle n'a plus de point d'accès dans sa zone (`sync-openrouter.py` : « ✘ <nom> : … ; déclaration laissée en l'état ») et que son double `<nom>-scaleway` est servi.
1. 🧑 Une nouveauté, avec un préavis dont l'utilisateur fixe la durée : date de la reprise, hébergeur et prix de `<nom>` chez Scaleway, et date de fin de service de `<nom>-scaleway`, que les clés gardent jusque-là.
2. Une version publiée retire `<nom>` de la liste blanche OpenRouter. Dans `declare-modeles-directs.py`, elle ajoute une entrée `<nom>` aux faits de `<nom>-scaleway`, qui reste déclaré jusqu'à sa fin de service.
3. Le jour dit, cette version est mise en production (phase 9, `infra/` compris). La version de Scaleway doit être créée, pas mise à jour : `declare-modeles-directs.py` met à jour la route, l'adresse et la clé d'un modèle présent sous le même nom, sans toucher à ses tarifs, et `<nom>` garderait ceux d'OpenRouter. D'où la mise en production le jour même : entre elle et la suppression, ce script ne doit pas tourner. Sur le serveur :
   1. le plan de la liste blanche montre `<nom>` comme seul modèle hors liste (« ✘ <nom> : modèle OpenRouter hors liste blanche ») :
      ```bash
      ssh ia-host 'cd /opt/linagora-ia && docker compose exec -T litellm python3 - < scripts/sync-openrouter.py'
      ```
   2. 🧑 confirmation explicite de l'utilisateur ;
   3. suppression de la version OpenRouter (« supprimé »), puis aussitôt déclaration de la version de Scaleway (« • <nom> : déclaré », pas « informations complétées ») ; `<nom>` manque quelques secondes entre les deux :
      ```bash
      ssh ia-host 'cd /opt/linagora-ia && docker compose exec -T litellm python3 - --supprimer-hors-liste < scripts/sync-openrouter.py'
      ssh ia-host 'cd /opt/linagora-ia && docker compose exec -T litellm python3 - < scripts/declare-modeles-directs.py'
      ```

   Puis, 🧑 dans la fiche de `<nom>`, mettre à jour les textes (hébergeur, zone, prix) et régler « Niveau maximal » au niveau de la version de Scaleway, puis Enregistrer. **Contrôle** : recette `smoke-test.py <nom>` (phase 5) en code 0.
4. À sa date, `<nom>-scaleway` suit la fin de service ci-dessus.

**Sortie de l'essai d'un modèle** :
- **Critères** :
  - recette `smoke-test.py <nom>` en code 0 ;
  - pour un modèle d'embeddings, vecteurs comparés à ceux d'OVH (mesure du ticket #212) ;
  - quatre semaines d'essai au moins depuis la publication de sa fiche (date du journal d'installation) : la supervision ne sonde que les fiches visibles ;
  - 🧑 le bilan des pannes et des rétablissements que la supervision a signalés sur cette période est présenté à l'utilisateur, qui décide. Il se tire des courriels reçus par les admins (`ADMIN_NOTIFICATION_EMAILS` : panne après deux échecs consécutifs, puis rétablissement), de l'état du modèle dans Gestion › Supervision (« Depuis » : début de l'état actuel) et des journaux du portail, qui ne remontent pas forcément à quatre semaines (cinq fichiers de 20 Mo) :
    ```bash
    ssh ia-host 'cd /opt/linagora-ia && docker compose logs portal | grep -F "Supervision des modèles" | grep -F "<nom> ("'
    ```
- **Condition** : 🧑 l'accord du juridique (ticket #220). D'ici là, aucun modèle de Scaleway ne reçoit de données N3.
- **Étapes**, pour chaque modèle retenu :
  1. le niveau déclaré, celui du reporting, passe à N3 pour ce modèle dans `declare-modeles-directs.py`, par une version publiée. Le script, rejoué sur le serveur, répond « informations complétées » : le niveau est réécrit, les tarifs ne changent pas ;
  2. 🧑 le niveau de la fiche passe à N3 : Gestion › Catalogue, « Niveau maximal » N3, Enregistrer. C'est ce niveau que le portail applique, au catalogue comme aux demandes de clé ;
  3. 🧑 une nouveauté, le même jour : modèles disponibles en N3. À la sortie de l'essai du lot (#221), elle annonce aussi la date de la bascule, un mois plus tard ; les nouveaux prix de qwen3.8 et le plafond de sa sortie, avec la demande de régénérer les configurations d'OpenCode et de Claude Code ; le changement d'index, si les vecteurs diffèrent ; la fin de service de `qwen3.8-scaleway` et de `qwen3-embedding-8b-scaleway` le jour de la bascule.

**Quotas** : Scaleway les fixe pour l'organisation, en requêtes et en jetons par minute et par modèle, avec 100 requêtes simultanées tous modèles confondus.
- Ils sont partagés par tous les projets de l'organisation : la passerelle, qui n'a qu'une clé, consomme les mêmes quotas que les autres projets.
- Ils augmentent quand l'identité du titulaire est vérifiée, en plus du moyen de paiement. Au-delà, il faut passer par le support ou le service commercial de Scaleway.
- 🧑 Ils se lisent dans la console, page Rate Limits des Generative APIs (`https://console.scaleway.com/generative-api/rate-limits`). Sous AI › Generative APIs, onglet « Rate limit », une limite par projet est possible, sous le quota de l'organisation.
- Le tableau public des quotas omet plusieurs modèles servis, dont `qwen3.8-27b`, `glm-5.3`, les DeepSeek et `lightonocr-3-0.8b`. Pour un modèle de conversation, `lire-quotas-scaleway.py` les lit dans les en-têtes `x-ratelimit-*` d'une réponse de Scaleway, au prix d'un jeton ; l'adresse et la clé restent dans le conteneur de LiteLLM. Pour les autres modèles, la console. Le 2026-11-21, pour `qwen3.8-27b` : 600 requêtes et 7 000 000 jetons par minute.
  ```bash
  ssh ia-host 'cd /opt/linagora-ia && docker compose exec -T litellm python3 - <nom chez Scaleway> < scripts/lire-quotas-scaleway.py'
  ```
  Réponse attendue : « • <nom> : HTTP 200 », puis une ligne par en-tête (`x-ratelimit-limit-requests : 600`…). Un nom inconnu de Scaleway ou une clé refusée donne « ✘ <nom> : HTTP <code> … », code de sortie 1.

## Dépannage rapide
- `docker compose logs -f <service>` ; `docker stats --no-stream` (mémoire : la B2-15 est juste).
- Certificat non émis : DNS non propagé ou port 80 bloqué → `docker compose logs caddy`.
- SSO en échec : comparer l'URI de redirection déclarée dans LemonLDAP avec celle du PRD §4.3 (`https://ai-gateway.linagora.com/api/auth/callback/lemonldap`, à l'identique).
- `/admin` ou `/stats` en 502 : le portail n'est pas démarré (point de contrôle) ; 403 : uid absent de `PORTAL_ADMIN_UIDS` / `PORTAL_REPORTING_UIDS`.
- Session perdue en passant du portail à `/stats` ou `/admin` : collision de cookies sur le même domaine → vérifier les noms de cookies (Superset : `superset_session`).
