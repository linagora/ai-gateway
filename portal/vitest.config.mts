import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
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
