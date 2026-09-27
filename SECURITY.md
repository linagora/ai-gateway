# Security policy

LINAGORA AI Gateway handles API keys, budgets and the identity of LINAGORA employees. We take every report
seriously and are grateful to anyone who helps keep it safe.

## Supported versions

The gateway is deployed continuously from the `main` branch. Security fixes are made on `main` only.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public issues, pull requests or comments.**

Report them privately with GitHub's private vulnerability reporting: open the repository's **Security** tab
and choose **Report a vulnerability**, or go directly to
[the reporting form](https://github.com/linagora/ai-gateway/security/advisories/new).

Please include as much of the following as you can:

- the component concerned: portal, integration API, gateway configuration and hooks (`infra/litellm`),
  reverse proxy (`infra/caddy`), deployment files or scripts;
- the commit or version where you found it;
- a description of the vulnerability and of its impact;
- the steps to reproduce it, or a proof of concept;
- a fix or mitigation, if you have one in mind.

Never include real API keys, integration tokens, passwords or personal data in a report: redact them.

## What to expect

- We acknowledge your report and keep you informed of its assessment and of the fix.
- We may ask you for details, and we coordinate with you the date of any public disclosure.
- Once a fix is deployed, we publish a security advisory and credit you for the finding, unless you prefer
  to remain anonymous.

## Guidelines for security research

- Use the local development environment described in [CONTRIBUTING.md](CONTRIBUTING.md) whenever you can:
  it runs the whole portal and gateway on your machine, with fictional data and mocked models.
- If you must interact with the production service, only use accounts and keys you own, never access or
  modify other people's data, and do not degrade the service (no load or denial-of-service testing).
- Stop and report as soon as you have shown that a vulnerability exists.

## Scope

In scope: the code and configuration of this repository, including the portal and its integration API, the
LiteLLM configuration and hooks, the Caddy configuration, and the deployment files and scripts.

Out of scope: vulnerabilities of upstream projects such as LiteLLM, Next.js, Caddy, PostgreSQL or Superset,
which should be reported to their maintainers (tell us too if our configuration exposes them), and the
services of the model providers.
