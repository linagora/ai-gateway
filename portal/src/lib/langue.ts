/** Langues du portail (spécification #1) : français par défaut, anglais. */
export const LANGUES = ["fr", "en"] as const;
export type Langue = (typeof LANGUES)[number];

/** Cookie qui mémorise le choix du sélecteur FR | EN. */
export const COOKIE_LANGUE = "portal.langue";

function estLangue(valeur: string | undefined): valeur is Langue {
  return (LANGUES as readonly string[]).includes(valeur ?? "");
}

/**
 * Langue d'une requête : le choix mémorisé, sinon la première langue du navigateur que le portail
 * connaît (dans l'ordre de préférence de l'en-tête Accept-Language), sinon le français.
 */
export function langueDemandee(cookie: string | undefined, acceptLanguage: string | null): Langue {
  if (estLangue(cookie)) return cookie;
  const preferences = (acceptLanguage ?? "")
    .split(",")
    .map((element, rang) => {
      const [etiquette, ...parametres] = element.trim().split(";");
      const q = Number(parametres.find((p) => p.trim().startsWith("q="))?.trim().slice(2) ?? 1);
      return { langue: etiquette.trim().toLowerCase().split("-")[0], q: Number.isNaN(q) ? 0 : q, rang };
    })
    .filter((p) => p.langue && p.q > 0)
    .sort((a, b) => b.q - a.q || a.rang - b.rang);
  return preferences.map((p) => p.langue).find(estLangue) ?? "fr";
}
