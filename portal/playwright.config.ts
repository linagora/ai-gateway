import { defineConfig, devices } from "@playwright/test";

// Parcours de bout en bout contre l'environnement de dev (dev/docker-compose.yml + dev/seed-litellm.sh),
// avec le fournisseur OIDC simulé à la place de LemonLDAP::NG : npm run test:e2e
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://localhost:3100", locale: "fr-FR" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3100/api/auth/providers",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
