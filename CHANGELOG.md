# Changelog

Notable changes to LINAGORA AI Gateway, newest first. The gateway and its portal are deployed continuously from
`main`, so changes are grouped by month rather than by version. Numbers refer to pull requests.

## October 2026

### Added

- **Claude Code** set up from issued keys: one launcher per key, with a step-by-step guide for Ubuntu (#151).
  Claude Code also works with `qwen3.8`, hosted in France on OVHcloud (#170).
- **Budget in key requests and budget increases.** A key request states the budget it needs, prefilled with the
  default value and justified above it; the holder of an issued key can ask for a higher budget, approved like a
  key request, without changing the key (#161).
- **OpenCode** configuration built from issued keys (#121), checked against reference configurations (#138).
- **Model monitoring.** Catalog models are probed every 10 minutes through the same route as employees;
  administrators get an email on failure and on recovery, and employees see the state of each model (#143).
- **News bell.** Announcements of new models and features, in Markdown, in English and French (#137).
- Models: three OVHcloud embedding models at the N3 Confidential level, with a filter by API type (#136); Nox-4B,
  a structured decision API at N3, free of charge, running on a LINAGORA GPU (#139); MiMo-V2.6-Pro (#107, #108,
  #122); Nemotron 3.5 Content Safety (#145); Perplexity Sonar, with the cost of its web search counted on each
  request (#146); DeepSeek V4.1 Flash 1017 (#150).

### Changed

- DeepSeek V4.1 Flash, DeepSeek V4 Pro, GLM-5.3 Flash and Gemini 2.5 Flash run outside the EU, by providers that
  do not collect the data and at most at their previous price, after their European providers stopped serving
  them or served them poorly (#141, #144, #172).
- Models that search the web on every request are no longer probed by the monitoring, since each probe would be
  billed (#148).
- The portal embeds the Inter font, so that it renders the same on every workstation (#168).

### Removed

- GLM-5.2, from the model allowlist (#110).

### Fixed

- Budget increases: amounts are rounded to the cent and written in the portal's currency format everywhere; the
  approval page and the archive show the amount granted, and the team budget warning follows the amount the
  approver enters (#176).
- Streamed responses are charged at the model's declared euro price, instead of the provider's cost in dollars
  (#149).
- Tokens read from the cache are charged at their declared price; they cost nothing before (#120).
- A model without any available endpoint no longer stops the allowlist synchronization (#109).
- Claude Code launcher: no context size guessed for a default model that declares none, a `/model` example that
  names another model of the key, and no promise that only the gateway is called (#175).

### Development

- Continuous integration on GitHub Actions: lint, types, unit and integration tests, end-to-end journeys (#152);
  code coverage with minimum thresholds (#169); journeys run against a production build of the portal, with
  their default values set beforehand (#167, #171). Actions are pinned to commit hashes and the runner to its
  version, and the journeys block a merge when they fail (#174).
- Test and documentation fixes (#140, #147).

## September 2026

First release of the gateway and its portal.

### Added

- **Gateway.** LiteLLM Proxy, community edition, behind Caddy, with PostgreSQL, Apache Superset and Valkey;
  pinned images, secrets generated on the server, model prices declared in euros, and an installation runbook
  (#28).
- **Portal** (#29, #30, #32): single sign-on through LemonLDAP::NG, model catalog by confidentiality level, key
  and team access requests, approval, self-service keys, expiry reminders and email notifications, in English
  and French.
- Audio models and the transcription use case (#31); image models and their use cases (#34).
- **Teams.** Team management, team managers who approve their team's requests but never their own (#44), team
  budgets with alerts at 80% and 100% (#46), team keys and paginated archives (#48, #50), an employee page
  (#67), and management pages refreshed every 30 seconds (#103).
- **Individual subscriptions** to providers' offers, as the second path of the catalog after the gateway's
  models (#61, #62), approved in two steps, the team manager then an administrator (#99), with the list of
  reimbursements for accounting, excluding tax, and its exports (#69, #70).
- **Integration API** for other applications acting for one employee: requests and teams (#83), keys (#89),
  OpenAPI contract in Swagger UI (#84), and an integration guide in the portal (#85).
- JEV, a structured decision model, through OpenRouter's System One API (#105).
- Administrators' dashboard (#33), classification badges (#44) and level pages with Lucide icons (#47).
- Community README, license, security policy and contribution guide (#86, #87).

### Changed

- PostgreSQL 18.6 and Node.js 24 LTS (#63).
- `qwen3.8` routed through LiteLLM's OVHcloud provider (#64).
- The French portal says "collaborateur" rather than "salarié" (#68).
- GLM-5.2 capped at Inceptron's price (#92).
- `/v1/messages` documented without naming a client tool (#66).

### Fixed

- French typography: non-breaking spaces (#45), and the "per million tokens" unit kept on one line (#49).
- Portal menus, management badges and the active tab (#65); tabs when the address changes while loading (#101);
  catalog filter applied before the page is ready (#90).
- Simultaneous first requests of an employee through an integration (#88).
- The email asking for more information says who asks for it (#100).
- Development: translations left by the screenshots in the development catalog (#91); JEV no longer counted
  in the allowlist acceptance test (#106).
