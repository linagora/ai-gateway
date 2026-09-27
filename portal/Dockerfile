# syntax=docker/dockerfile:1
# Portail Linagora (brief §1) : image multi-étapes, sortie standalone de Next.js, utilisateur non root, port 3000.
#   docker build -t linagora-ia/portal:local .                  → image d'exécution (cible runner)
#   docker build --target migrate -t linagora-ia/portal-migrate .  → migrations Prisma (migrate deploy)
ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

FROM ${NODE_IMAGE} AS deps
# openssl : requis par le moteur de migrations de Prisma (absent de l'image slim)
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Aucune statistique d'installation : le script de @scarf/scarf (dépendance de swagger-ui-dist) ne rapporte rien.
ENV SCARF_ANALYTICS=false
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npx next build

# Migrations : la CLI Prisma n'est pas dans la sortie standalone ; cette cible la contient.
FROM build AS migrate
ENV PRISMA_HIDE_UPDATE_MESSAGE=1
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/auth/providers').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "server.js"]
