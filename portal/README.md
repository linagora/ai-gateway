# Portail Linagora

Portail des clés d'API IA : catalogue des modèles, demandes validées par les administrateurs, classification des
données N1 / N2 / N3. Spécification : [`docs/PRD.md`](../docs/PRD.md) et [`docs/PORTAL-BRIEF.md`](../docs/PORTAL-BRIEF.md).

Stack : Next.js 16 (App Router, Server Actions), TypeScript strict, Auth.js 5 (OIDC LemonLDAP::NG), Prisma 7
(PostgreSQL), zod, Vitest, Playwright.

## Environnement de développement

Tout tourne en local, sans aucune donnée ni clé de production.

```bash
docker compose -f dev/docker-compose.yml up -d   # Postgres, LiteLLM (même version que la prod), OIDC simulé
./dev/seed-litellm.sh                            # 3 modèles à réponses simulées + équipe « R&D »
cp .env.example .env                             # valeurs de développement
npm install
npx prisma generate && npx prisma migrate deploy
npm run dev                                      # http://localhost:3100
node dev/integration-demo.mjs installer          # intégration « demo » de l'API /api/v1 (clé privée hors dépôt)
```

Connexion : le fournisseur OIDC simulé demande un utilisateur (l'uid) et des claims, par exemple
`{"email": "mmaudet@linagora.com", "name": "Michel-Marie Maudet"}`. `mmaudet` est admin (`PORTAL_ADMIN_UIDS`).

API d'intégration (`/api/v1`, contrat dans `src/lib/integrations/openapi-v1.json`) : l'intégration « demo » signe des
jetons de test, et le Caddy de dev transmet au portail l'adresse de l'appelant, comme en production :

```bash
curl -H "Authorization: Bearer $(node dev/integration-demo.mjs jeton jdupont)" http://127.0.0.1:54600/api/v1/me/teams
```

## Tests

| Commande | Contenu |
|---|---|
| `npm test` | Tests unitaires : règles métier (`src/lib/policy.ts`), conversion des claims OIDC, provisionnement |
| `npm run test:int` | Tests d'intégration : client LiteLLM contre le LiteLLM de dev (contrat), cas d'usage contre la base `portal_test` |
| `npm run test:e2e` | Parcours complet dans un navigateur (Playwright) : catalogue, adhésion, demande, refus du critère 5, approbation |

Les tests d'intégration et de bout en bout nécessitent l'environnement de développement démarré.

## Organisation

| Chemin | Rôle |
|---|---|
| `src/lib/policy.ts` | Règles métier pures (brief §4) |
| `src/lib/litellm/client.ts` | Client typé de l'API d'administration LiteLLM (serveur uniquement) |
| `src/lib/services/` | Cas d'usage : provisionnement, catalogue, demandes, validation, valeurs par défaut |
| `src/lib/integrations/` | API d'intégration : contrat OpenAPI, vérification des jetons, contrôles de chaque appel |
| `src/app/api/v1/` | Routes de l'API d'intégration |
| `src/lib/session.ts` | Utilisateur courant et dépendances réelles (couche d'accès aux données) |
| `src/auth.ts`, `src/proxy.ts` | Auth.js (OIDC) et vérification optimiste de la session |
| `src/app/` | Pages (interface minimale V1) et Server Actions |
| `prisma/` | Schéma et migrations de la base `portal` |
| `dev/` | Environnement de développement local |
| `e2e/` | Tests Playwright |
