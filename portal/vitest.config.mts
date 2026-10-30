import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    // Couverture des tests unitaires et d'intégration (npm run test:coverage) : règles métier et services de src/lib. Les
    // pages et les routes de src/app relèvent des parcours de bout en bout, qu'elle ne mesure pas.
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "text-summary", "lcov"],
      // Couverture mesurée à l'introduction des seuils (2026-10-30), arrondie à l'entier inférieur : un recul fait échouer
      // la commande. À relever quand la couverture progresse.
      thresholds: { statements: 86, branches: 79, functions: 86, lines: 88 },
    },
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["src/**/*.test.ts"], exclude: ["src/**/*.int.test.ts"] },
      },
      {
        // Tests contre l'environnement de dev (dev/docker-compose.yml, valeurs dans src/test/config.ts).
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          testTimeout: 30_000,
          globalSetup: ["./src/test/global-setup.ts"],
          // Une seule base de test : les fichiers s'exécutent l'un après l'autre.
          fileParallelism: false,
        },
      },
    ],
  },
});
