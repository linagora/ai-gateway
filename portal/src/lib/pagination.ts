/** Éléments affichés par page dans les archives de la gestion. */
export const PAR_PAGE = 50;

/** Une page d'une liste : ses éléments, son numéro (ramené entre 1 et le nombre de pages), le nombre de pages et d'éléments. */
export interface Page<T> {
  elements: T[];
  page: number;
  pages: number;
  total: number;
}

/** Page demandée ramenée entre 1 et le nombre de pages, et la tranche à lire en base (`skip`, `take`). */
export function tranche(total: number, demandee: number): { page: number; pages: number; skip: number; take: number } {
  const pages = Math.max(1, Math.ceil(total / PAR_PAGE));
  const page = Math.min(Math.max(1, Math.trunc(demandee) || 1), pages);
  return { page, pages, skip: (page - 1) * PAR_PAGE, take: PAR_PAGE };
}
