import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { COOKIE_LANGUE, langueDemandee } from "@/lib/langue";

// Pas de préfixe de langue dans les adresses (décision Q21) : la langue vient du cookie, sinon du navigateur.
export default getRequestConfig(async () => {
  const locale = langueDemandee((await cookies()).get(COOKIE_LANGUE)?.value, (await headers()).get("accept-language"));
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    timeZone: "Europe/Paris",
  };
});
