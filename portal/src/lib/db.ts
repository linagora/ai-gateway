import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

export type Db = PrismaClient;

export function createDb(connectionString: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Une seule instance par processus (le rechargement à chaud de `next dev` réévalue les modules).
const globalForDb = globalThis as unknown as { portalDb?: Db };

export function getDb(): Db {
  globalForDb.portalDb ??= createDb(requiredEnv("DATABASE_URL"));
  return globalForDb.portalDb;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variable d'environnement manquante : ${name}`);
  return value;
}
