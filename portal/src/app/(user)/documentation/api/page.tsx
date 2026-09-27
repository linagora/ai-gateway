import { getTranslations } from "next-intl/server";
import contrat from "@/lib/integrations/openapi-v1.json";
import { requireUser } from "@/lib/session";
import { SwaggerUi } from "./swagger-ui";

/** Adresse du guide d'intégration, dans le dépôt. */
const GUIDE = "https://github.com/linagora/ai-gateway/blob/main/docs/INTEGRATIONS.md";

/**
 * Documentation de l'API d'intégration (spécification #71) : le contrat dans Swagger UI, pour les collaborateurs
 * connectés, avec l'essai des routes par un jeton d'intégration, soumis aux contrôles de tout appel de l'API.
 */
export default async function DocumentationApiPage() {
  await requireUser();
  const t = await getTranslations("documentationApi");
  return (
    <>
      <h1>{t("titre")}</h1>
      <p className="text-sm text-neutral-600">
        {t.rich("introduction", { guide: (texte) => <a href={GUIDE}>{texte}</a> })}
      </p>
      <p className="text-sm">{t("essai")}</p>
      <SwaggerUi contrat={contrat} />
    </>
  );
}
