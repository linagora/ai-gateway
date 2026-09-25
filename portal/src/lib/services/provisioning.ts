import type { SessionUser } from "@/lib/auth-user";
import type { LiteLLMClient } from "@/lib/litellm/client";

/** F-02 : à la connexion, crée l'utilisateur dans LiteLLM s'il n'existe pas encore (sans clé). */
export async function provisionUser(deps: { litellm: LiteLLMClient }, user: SessionUser): Promise<void> {
  if (await deps.litellm.getUser(user.uid)) return;
  await deps.litellm.createUser({ userId: user.uid, email: user.email });
}
