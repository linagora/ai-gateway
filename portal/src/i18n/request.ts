import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { COOKIE_LANGUE, langueDemandee } from "@/lib/langue";
import { typographieFrancaise } from "@/lib/typographie";

// Pas de préfixe de langue dans les adresses (décision Q21) : la langue vient du cookie, sinon du navigateur.
export default getRequestConfig(async () => {
  const locale = langueDemandee((await cookies()).get(COOKIE_LANGUE)?.value, (await headers()).get("accept-language"));
  const messages = (await import(`../../messages/${locale}.json`)).default;
  return {
    locale,
    // En français, espaces insécables avant « ; : ! ? » et dans les guillemets : aucune ligne ne commence par ces signes.
    messages: locale === "fr" ? typographieFrancaise(messages) : messages,
    timeZone: "Europe/Paris",
  };
});
