import "server-only";
import { requiredEnv } from "@/lib/db";
import { createLiteLLMClient, type LiteLLMClient } from "./client";

/**
 * Client LiteLLM du portail (réseau interne, clé maître côté serveur uniquement). Sans état, il est créé à
 * chaque appel : aucune instance globale ne survit à un rechargement du code en développement.
 */
export function getLiteLLM(): LiteLLMClient {
  return createLiteLLMClient({ baseUrl: requiredEnv("LITELLM_BASE_URL"), masterKey: requiredEnv("LITELLM_MASTER_KEY") });
}
