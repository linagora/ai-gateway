/** Espace insécable : elle sépare les mots sans permettre de retour à la ligne. */
const INSECABLE = " ";

/**
 * Typographie française : l'espace avant « ; : ! ? » et à l'intérieur des guillemets devient insécable, pour qu'aucune
 * ligne ne commence par l'un de ces signes ni ne se termine par un guillemet ouvrant. L'espace avant « :: » reste : elle
 * précède un format de nombre ICU (::currency/EUR), que next-intl ne reconnaîtrait plus.
 */
export function espacesInsecables(texte: string): string {
  return texte.replace(/ (?!::)([;:!?»])/g, `${INSECABLE}$1`).replace(/« /g, `«${INSECABLE}`);
}

/** Applique `espacesInsecables` à tous les textes d'un dictionnaire, objets et listes imbriqués compris. */
export function typographieFrancaise<T>(dictionnaire: T): T {
  if (typeof dictionnaire === "string") return espacesInsecables(dictionnaire) as T;
  if (Array.isArray(dictionnaire)) return dictionnaire.map((valeur) => typographieFrancaise(valeur)) as T;
  if (dictionnaire !== null && typeof dictionnaire === "object") {
    return Object.fromEntries(Object.entries(dictionnaire).map(([cle, valeur]) => [cle, typographieFrancaise(valeur)])) as T;
  }
  return dictionnaire;
}
