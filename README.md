# Passerelle IA Linagora — kit de démarrage

Plateforme d'accès aux modèles d'IA : **LiteLLM Proxy (communautaire)** + **Portail Linagora** (demandes de clés validées par les admins, classification N1/N2/N3) + **Superset** (reporting) + **Langfuse** (phase 2), sur une instance OVH B2-15, avec le SSO LemonLDAP::NG.

## Contenu
| Chemin | Rôle |
|---|---|
| `docs/PRD.md` | PRD simplifié : besoin, architecture, composants, exigences, critères d'acceptation |
| `docs/RUNBOOK-INSTALL.md` | Installation distante pas à pas, pilotée par un agent de code via SSH |
| `docs/PORTAL-BRIEF.md` | Brief de développement du portail (Next.js / TypeScript) |
| `infra/` | Fichiers déployés dans `/opt/linagora-ia` : compose, Caddy, LiteLLM, Postgres, vues de reporting, Superset, scripts |

## Démarrer avec un agent de code (sur votre PC)

1. Placez ce dossier dans un dépôt git privé et ouvrez-le avec votre agent de code.
2. Configurez l'alias SSH `ia-host` dans `~/.ssh/config` (voir runbook, phase 0) et vérifiez `ssh ia-host true`.
3. Premier message à donner à l'agent :

   > Lis docs/PRD.md et docs/RUNBOOK-INSTALL.md. Exécute le runbook à partir de la phase 0 sur `ia-host`, phase par phase. Avant chaque phase, annonce ce que tu vas faire ; après chaque phase, lance les contrôles et consigne le résultat dans docs/INSTALL-LOG.md. Arrête-toi à chaque point 🧑 et dis-moi exactement ce que je dois faire ou fournir.

4. Une fois le socle recetté (phase 8), second message :

   > Lis docs/PORTAL-BRIEF.md et développe le portail dans portal/ en suivant le plan de livraison, étape par étape, avec tests et commits. Monte un environnement local (Postgres + LiteLLM en docker compose) pour tester contre l'API réelle. Quand les critères 4 à 6 du PRD passent en local, déploie avec la phase 9 du runbook.

## À préparer de votre côté
- DNS : `ai-gateway.linagora.com` et `ai-api.linagora.com` vers l'IP de l'instance.
- Clients OIDC dans LemonLDAP::NG (PRD §4.3), avec une règle d'accès limitant `litellm-admin` aux admins.
- Clé d'API OpenRouter, paramètres de l'endpoint OVHcloud Qwen3.8 (N3), taux USD→EUR, paramètres SMTP, liste des uid admins, IP autorisées pour l'administration.
- Décisions ouvertes : PRD §11.
