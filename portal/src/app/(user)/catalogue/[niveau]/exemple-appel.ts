import type { ApiKind } from "@/lib/litellm/client";

/** Adresse publique de l'API (plan d'adresses de la passerelle), sauf configuration contraire. */
const ADRESSE_PAR_DEFAUT = "https://ai-api.linagora.com/v1";

/** Textes d'exemple, dans la langue du salarié. */
interface TextesExemple {
  message: string;
  etat: string;
  question: string;
}

/**
 * Exemple d'appel prêt à copier (curl), avec l'adresse publique de la passerelle et le nom du modèle.
 * Une API de décision comme JEV reçoit dans le dernier message sa requête « System One » en JSON :
 * un état et des questions typées (voir litellm/jev.py côté passerelle).
 */
export function exempleAppel(modelName: string, apiKind: ApiKind, textes: TextesExemple): string {
  const adresse = (process.env.PUBLIC_API_BASE_URL || ADRESSE_PAR_DEFAUT).replace(/\/$/, "");
  const contenu =
    apiKind === "decision"
      ? JSON.stringify({ state: textes.etat, questions: { urgent: { type: "noul", instructions: textes.question } } })
      : textes.message;
  const corps = JSON.stringify({ model: modelName, messages: [{ role: "user", content: contenu }] }, null, 2);
  return [
    `curl ${adresse}/chat/completions \\`,
    `  -H "Authorization: Bearer $LINAGORA_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${corps.replaceAll("'", "'\\''")}'`,
  ].join("\n");
}
