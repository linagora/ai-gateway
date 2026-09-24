import "server-only";
import { requiredEnv } from "@/lib/db";
import { createLiteLLMClient, type LiteLLMClient } from "./client";

const globalForLiteLLM = globalThis as unknown as { portalLiteLLM?: LiteLLMClient };

/** Client LiteLLM du portail (réseau interne, clé maître côté serveur uniquement). */
export function getLiteLLM(): LiteLLMClient {
  globalForLiteLLM.portalLiteLLM ??= createLiteLLMClient({
    baseUrl: requiredEnv("LITELLM_BASE_URL"),
    masterKey: requiredEnv("LITELLM_MASTER_KEY"),
  });
  return globalForLiteLLM.portalLiteLLM;
}
