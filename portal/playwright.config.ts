import { defineConfig, devices } from "@playwright/test";

// Parcours de bout en bout contre l'environnement de dev (dev/docker-compose.yml + dev/seed-litellm.sh),
// avec le fournisseur OIDC simulé à la place de LemonLDAP::NG : npm run test:e2e
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  reporter: "list",
  // Trace d'un parcours en échec, dans test-results/ : la CI la garde en artefact.
  use: { baseURL: "http://localhost:3100", locale: "fr-FR", trace: "retain-on-failure" },
  // Les valeurs par défaut des clés (e2e/reglages.setup.ts) sont posées avant les parcours, même sur une base neuve.
  projects: [
    { name: "reglages", testMatch: /reglages\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, dependencies: ["reglages"] },
  ],
  // Le serveur déjà lancé sur le port 3100 est repris. Sinon, sur la CI, le serveur de production construit par
  // npm run build : le serveur de dev compile chaque route à sa première visite, et des parcours expiraient pendant ce
  // temps (#154). next start y signale la sortie standalone, que seule l'image Docker utilise.
  webServer: {
    command: process.env.CI ? "npm run start -- -p 3100" : "npm run dev",
    url: "http://localhost:3100/api/auth/providers",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
