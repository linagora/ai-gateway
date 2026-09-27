import { defineConfig, devices } from "@playwright/test";

// Captures d'écran du README (docs/screenshots), sur l'environnement de dev : npm run captures. Hors de la suite de
// tests : le scénario crée des données de démonstration, sans jamais toucher à la production.
export default defineConfig({
  testDir: ".",
  outputDir: "../../test-results/captures",
  timeout: 10 * 60_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://localhost:3100", actionTimeout: 30_000 },
  // Pages de 1280 × 800, photographiées en double densité pour rester nettes dans le README.
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 } }],
});
