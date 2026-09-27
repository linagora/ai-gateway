import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { marked } from "marked";
import { requireUser } from "@/lib/session";

/** Guide d'intégration dans chaque langue du portail, tenu avec lui (docs/). */
const GUIDES = { fr: "INTEGRATIONS.md", en: "INTEGRATIONS.en.md" } as const;

/**
 * Guide d'intégration, dans la langue du portail, affiché à tout collaborateur connecté. Le Markdown vient du dépôt,
 * jamais d'un utilisateur : son rendu HTML est affiché tel quel.
 */
export default async function GuideIntegrationPage() {
  await requireUser();
  const langue = (await getLocale()) === "en" ? "en" : "fr";
  const [t, markdown] = await Promise.all([getTranslations("documentationApi"), readFile(join(process.cwd(), "docs", GUIDES[langue]), "utf8")]);
  return (
    <>
      <p className="text-sm">
        <Link href="/documentation/api">{t("versContrat")}</Link>
      </p>
      <article className="guide" dangerouslySetInnerHTML={{ __html: await marked.parse(markdown) }} />
    </>
  );
}
