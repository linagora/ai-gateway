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
  /** Description de l'image demandée à un modèle d'images. */
  image: string;
  /** Deux textes à transformer en vecteurs par un modèle d'embeddings. */
  aVectoriser: readonly [string, string];
}

/** Clés des textes d'exemple dans l'espace de messages « detail ». */
type CleExemple = "exemple.message" | "exemple.etat" | "exemple.question" | "exemple.image" | "exemple.aVectoriser1" | "exemple.aVectoriser2";

/** Textes d'exemple dans la langue du collaborateur, lus par le traducteur de l'espace « detail ». */
export function textesExemple(t: (cle: CleExemple) => string): TextesExemple {
  return {
    message: t("exemple.message"),
    etat: t("exemple.etat"),
    question: t("exemple.question"),
    image: t("exemple.image"),
    aVectoriser: [t("exemple.aVectoriser1"), t("exemple.aVectoriser2")],
  };
}

export const LANGAGES = ["curl", "python", "javascript"] as const;
export type Langage = (typeof LANGAGES)[number];

/**
 * Exemples d'appel prêts à copier, avec l'adresse publique de la passerelle et le nom du modèle. La clé n'y
 * figure jamais : elle est lue dans la variable d'environnement LINAGORA_API_KEY. Une API de décision comme
 * JEV reçoit dans le dernier message sa requête « System One » en JSON : un état et des questions typées.
 */
export function exemplesAppel(modelName: string, apiKind: ApiKind, textes: TextesExemple): Record<Langage, string> {
  if (apiKind === "image") return exemplesImage(modelName, textes.image);
  if (apiKind === "embeddings") return exemplesEmbeddings(modelName, textes.aVectoriser);
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

/**
 * Modèle d'images : une description et une image en sortie (« modalities »). L'image revient dans
 * message.images, en URL data: encodée en base64 ; l'exemple l'enregistre dans image.png.
 */
function exemplesImage(modelName: string, description: string): Record<Langage, string> {
  const adresse = adresseApi();
  const corps = JSON.stringify({ model: modelName, modalities: ["image"], messages: [{ role: "user", content: description }] }, null, 2);
  const litteral = JSON.stringify(description);
  return {
    curl: [
      `curl ${adresse}/chat/completions \\`,
      `  -H "Authorization: Bearer $LINAGORA_API_KEY" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '${corps.replaceAll("'", "'\\''")}' \\`,
      "  | jq -r '.choices[0].message.images[0].image_url.url' \\",
      "  | cut -d, -f2 | base64 --decode > image.png",
    ].join("\n"),
    python: [
      "import base64",
      "import os",
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${adresse}", api_key=os.environ["LINAGORA_API_KEY"])`,
      "response = client.chat.completions.create(",
      `    model="${modelName}",`,
      `    messages=[{"role": "user", "content": ${litteral}}],`,
      '    extra_body={"modalities": ["image"]},',
      ")",
      'image = response.choices[0].message.images[0]["image_url"]["url"]',
      'with open("image.png", "wb") as f:',
      '    f.write(base64.b64decode(image.split(",", 1)[1]))',
    ].join("\n"),
    javascript: [
      'import { writeFileSync } from "node:fs";',
      'import OpenAI from "openai";',
      "",
      `const client = new OpenAI({ baseURL: "${adresse}", apiKey: process.env.LINAGORA_API_KEY });`,
      "const response = await client.chat.completions.create({",
      `  model: "${modelName}",`,
      `  messages: [{ role: "user", content: ${litteral} }],`,
      '  modalities: ["image"],',
      "});",
      "const image = response.choices[0].message.images[0].image_url.url;",
      'writeFileSync("image.png", Buffer.from(image.split(",")[1], "base64"));',
    ].join("\n"),
  };
}

/**
 * Modèle d'embeddings : /v1/embeddings avec deux textes, qui rend un vecteur par texte. L'exemple affiche la taille
 * de chaque vecteur reçu, soit autant de nombres que de textes, chacun égal aux dimensions du modèle.
 */
function exemplesEmbeddings(modelName: string, aVectoriser: readonly [string, string]): Record<Langage, string> {
  const adresse = adresseApi();
  const corps = JSON.stringify({ model: modelName, input: aVectoriser }, null, 2);
  const litteraux = aVectoriser.map((texte) => JSON.stringify(texte)).join(", ");
  return {
    curl: [
      `curl ${adresse}/embeddings \\`,
      `  -H "Authorization: Bearer $LINAGORA_API_KEY" \\`,
      `  -H "Content-Type: application/json" \\`,
      `  -d '${corps.replaceAll("'", "'\\''")}' \\`,
      "  | jq '[.data[].embedding | length]'",
    ].join("\n"),
    python: [
      "import os",
      "from openai import OpenAI",
      "",
      `client = OpenAI(base_url="${adresse}", api_key=os.environ["LINAGORA_API_KEY"])`,
      "response = client.embeddings.create(",
      `    model="${modelName}",`,
      `    input=[${litteraux}],`,
      ")",
      "print([len(d.embedding) for d in response.data])",
    ].join("\n"),
    javascript: [
      'import OpenAI from "openai";',
      "",
      `const client = new OpenAI({ baseURL: "${adresse}", apiKey: process.env.LINAGORA_API_KEY });`,
      "const response = await client.embeddings.create({",
      `  model: "${modelName}",`,
      `  input: [${litteraux}],`,
      "});",
      "console.log(response.data.map((d) => d.embedding.length));",
    ].join("\n"),
  };
}
