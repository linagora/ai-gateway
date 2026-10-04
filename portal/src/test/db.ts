import { createDb } from "@/lib/db";
import { TEST_DATABASE_URL } from "./config";

/** Base de test (portal_test), vidée entre deux tests par resetDb(). */
export const testDb = createDb(TEST_DATABASE_URL);

export async function resetDb(): Promise<void> {
  await testDb.$executeRawUnsafe('TRUNCATE "IntegrationKey", "Integration", "ChargeTransmission", "SubscriptionCharge", "Subscription", "AccessRequest", "CatalogEntry", "Setting", "AuditLog", "TeamManager", "TeamBudgetAlert", "SubscriptionOffer", "NewsReceipt", "NewsItem" RESTART IDENTITY');
}
