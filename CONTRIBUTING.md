# Contributing to LINAGORA AI Gateway

Thank you for your interest in LINAGORA AI Gateway. Bug reports, ideas, documentation, translations and code
are all welcome. This guide explains how to set up the project and the conventions we follow.

Issues and pull requests can be written in English or French.

## Ways to contribute

- **Report a bug or suggest a feature** by opening an [issue](https://github.com/linagora/ai-gateway/issues/new/choose).
  Please search the existing issues first.
- **Report a vulnerability privately**, never in a public issue: see [SECURITY.md](SECURITY.md).
- **Improve the documentation or the translations** of the portal, in English or French.
- **Submit a pull request.** For anything larger than a small fix, open an issue first so that we can agree
  on the approach before you invest time in it.

## Development environment

The development environment runs the portal and the gateway entirely on your machine, with fictional data
and demo models whose answers are mocked: you need no production key.

Requirements: Docker with Compose, Node.js 24, `jq`, `curl`, and Python 3 for the maintenance scripts.

```bash
cd portal
docker compose -f dev/docker-compose.yml up -d  # PostgreSQL, LiteLLM, mock OpenID provider, Mailpit, Caddy
./dev/seed-litellm.sh                           # demo models priced in euros and an "R&D" team
cp .env.example .env                            # development values
npm install
npx prisma generate && npx prisma migrate deploy
npm run dev                                      # http://localhost:3100
```

- **Sign in.** The mock OpenID provider asks for a user name (the uid) and claims, such as
  `{"email": "jdoe@example.org", "name": "Jane Doe"}`. The uids listed in `PORTAL_ADMIN_UIDS` are
  administrators.
- **Emails.** Every email sent by the portal lands in Mailpit, at http://127.0.0.1:54825.
- **Integration API.** `node dev/integration-demo.mjs installer` declares a demo integration, and
  `node dev/integration-demo.mjs jeton <uid>` signs a token for it. Call the API through the development
  Caddy, at http://127.0.0.1:54600/api/v1, which passes the caller's address to the portal as in
  production.
- **Test data.** The tests leave data behind, which slows the end-to-end journeys down over time.
  `python3 dev/purger-donnees-de-test.py` counts it and `--appliquer` deletes it; never run it while a test
  suite is running.

[`portal/README.md`](portal/README.md) (in French) describes the organization of the portal's code.

## Checks

Run them from `portal/` before opening a pull request. Integration and end-to-end tests need the
development environment.

```bash
npm run lint
npx tsc --noEmit
npm test               # unit tests
npm run test:int       # integration tests, against the portal_test database and the development LiteLLM
npm run test:e2e       # end-to-end journeys (Playwright), emails checked in Mailpit
```

- **Test what you change**, at the right level: pure business rules in unit tests, services against the
  test database, user journeys end to end. Tests go through public interfaces: end-to-end tests find
  elements by role and label, as users do.
- **Screenshots.** When a page shown in the README changes, refresh the screenshots with
  `npm run captures`; the header of [`dev/captures/captures.spec.ts`](portal/dev/captures/captures.spec.ts)
  gives the settings of the development server it expects.

## Conventions

### Language

- The code base uses **French** for its domain vocabulary, identifiers, comments, commit messages and most
  documentation (*demande*, *clé*, *équipe*, *collaborateur*…). Please keep to it in the code you touch.
- Every text displayed by the portal lives in [`portal/messages/fr.json`](portal/messages/fr.json) and
  [`portal/messages/en.json`](portal/messages/en.json): add each new text in both languages. French texts
  say *collaborateur*, English texts say *employee*.
- The brand is written **LINAGORA**, in capitals, in any displayed text.

### Code

- TypeScript in strict mode. Business rules stay pure and tested; use cases live in
  `portal/src/lib/services/`, the LiteLLM admin API client in `portal/src/lib/litellm/`.
- A schema change comes with its SQL migration in `portal/prisma/migrations/`.
- Icons come from [Lucide](https://lucide.dev) (`lucide-react`), never from emojis or Unicode symbols.
- Accessible markup: every field has a label, and required fields are marked.
- The portal never uses the paths `/admin`, `/stats`, `/static` and `/traces`, which the reverse proxy routes
  to other services.

### Gateway and infrastructure

- Only features of the **LiteLLM community edition**: nothing marked Enterprise, and no change to LiteLLM's
  `enterprise/` directory.
- Before coding against a LiteLLM endpoint, check its schema in the OpenAPI document of the deployed version.
- **Pinned versions**: Docker images by tag and digest, never `latest`; new npm dependencies at an exact
  version. Each dependency upgrade gets its own commit.
- **No secrets in git**: no `.env` file (only `.env.example`), key, certificate or backup. Production secrets
  are generated on the server. Check `git status` before each commit.

### Commits

We follow [Conventional Commits](https://www.conventionalcommits.org), written in French, with a subject in
the imperative mood starting with a capital letter:

```text
feat(portail): Ajouter le renouvellement d'une clé
fix(infra): Corriger le routage des modèles d'images
docs(runbook): Décrire la mise à jour de LiteLLM
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`. Scopes in use: `portail`, `infra`,
  `litellm`, `reporting`, `runbook`.
- One subject per commit: a subject that needs "et" calls for two commits.
- The body, wrapped at 72 characters, explains why when the diff does not say it.

### Pull requests

- Branch from `main`: `feat/…`, `fix/…` or `chore/…`.
- One concern per pull request, with a short lowercase title (under 70 characters).
- The description is a short summary, in bullets, of what the pull request changes; link the issue it
  resolves (`Closes #123`).
- The maintainers review the pull request, merge it into `main`, and deploy from `main`.

## License

By contributing, you agree that your contributions are licensed under the
[GNU Affero General Public License v3.0](LICENSE), the license of the project.
