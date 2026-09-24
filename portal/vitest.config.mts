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
        // Tests de contrat contre l'environnement de dev (dev/docker-compose.yml) : valeurs FACTICES.
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.int.test.ts"],
          testTimeout: 30_000,
          env: {
            LITELLM_TEST_BASE_URL: "http://127.0.0.1:54400/admin",
            LITELLM_TEST_MASTER_KEY: "sk-dev-master-key",
          },
        },
      },
    ],
  },
});
