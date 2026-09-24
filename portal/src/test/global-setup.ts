import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./config";

/** Avant les tests d'intégration : applique les migrations à la base de test (portal_test). */
export default function setup(): void {
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL }, stdio: "pipe" });
}
