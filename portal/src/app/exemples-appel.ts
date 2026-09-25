import type { ApiKind } from "@/lib/litellm/client";

/** Adresse publique de l'API (plan d'adresses de la passerelle), sauf configuration contraire. */
const ADRESSE_PAR_DEFAUT = "https://ai-api.linagora.com/v1";

/** Adresse de l'API compatible OpenAI (endpoint) à donner aux salariés, sans barre oblique finale. */
export function adresseApi(): string {
  return (process.env.PUBLIC_API_BASE_URL || ADRESSE_PAR_DEFAUT).replace(/\/$/, "");
}

/** Textes d'exemple, dans la langue du salarié. */
export interface TextesExemple {
  message: string;
  etat: string;
  question: string;
}

export const LANGAGES = ["curl", "python", "javascript"] as const;
export type Langage = (typeof LANGAGES)[number];

/**
 * Exemples d'appel prêts à copier, avec l'adresse publique de la passerelle et le nom du modèle. La clé n'y
 * figure jamais : elle est lue dans la variable d'environnement LINAGORA_API_KEY. Une API de décision comme
 * JEV reçoit dans le dernier message sa requête « System One » en JSON : un état et des questions typées.
 */
export function exemplesAppel(modelName: string, apiKind: ApiKind, textes: TextesExemple): Record<Langage, string> {
  const adresse = adresseApi();
  const contenu =
    apiKind === "decision"
      ? JSON.stringify({ state: textes.etat, questions: { urgent: { type: "noul", instructions: textes.question } } })
      : textes.message;
  const corps = JSON.stringify({ model: modelName, messages: [{ role: "user", content: contenu }] }, null, 2);
  const litteral = JSON.stringify(contenu);
  return {
    curl: [
      `curl ${adresse}/chat/completions \\`,
      `  -H "Authorization: Bearer $LINAGORA_API_KEY" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '${corps.replaceAll("'", "'\\''")}'`,
    ].join("\n"),
    python: [
      "import os",
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${adresse}", api_key=os.environ["LINAGORA_API_KEY"])`,
      "response = client.chat.completions.create(",
      `    model="${modelName}",`,
      `    messages=[{"role": "user", "content": ${litteral}}],`,
      ")",
      "print(response.choices[0].message.content)",
    ].join("\n"),
    javascript: [
      'import OpenAI from "openai";',
      "",
      `const client = new OpenAI({ baseURL: "${adresse}", apiKey: process.env.LINAGORA_API_KEY });`,
      "const response = await client.chat.completions.create({",
      `  model: "${modelName}",`,
      `  messages: [{ role: "user", content: ${litteral} }],`,
      "});",
      "console.log(response.choices[0].message.content);",
    ].join("\n"),
  };
}
