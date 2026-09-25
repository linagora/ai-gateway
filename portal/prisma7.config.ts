// Configuration de la CLI Prisma 7. Les fichiers .env sont chargés comme par Next.js (@next/env) ;
// en production, DATABASE_URL vient de l'environnement du conteneur.
import { loadEnvConfig } from "@next/env";
import { defineConfig } from "prisma/config";

loadEnvConfig(process.cwd());

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
