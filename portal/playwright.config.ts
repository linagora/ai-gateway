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
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3100/api/auth/providers",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
