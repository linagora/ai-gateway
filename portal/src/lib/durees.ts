/**
 * Durées de validité d'une clé proposées au salarié et à l'admin (décision du 2026-09-25), en jours ;
 * SANS_EXPIRATION : la clé n'expire jamais.
 */
export const SANS_EXPIRATION = 0;
export const DUREES_VALIDITE = [1, 7, 30, 90, 180, 365, SANS_EXPIRATION] as const;

/** Période d'un budget, pour une clé comme pour une équipe : au format LiteLLM (30d, 12h…). */
export const PERIODE_BUDGET = /^\d+[smhd]$/;

/** Nombre de jours d'une période de budget exprimée en jours (30d : 30) ; null pour une autre unité (12h…). */
export function joursDePeriode(periode: string): number | null {
  const jours = /^(\d+)d$/.exec(periode);
  return jours ? Number(jours[1]) : null;
}

/**
 * Durées à proposer : la liste, plus la valeur courante si elle n'en fait pas partie (clé plus ancienne,
 * valeur par défaut configurée), à sa place dans l'ordre croissant ; « n'expire jamais » reste en dernier.
 */
export function optionsDuree(courante: number | null): number[] {
  const durees: number[] = DUREES_VALIDITE.filter((jours) => jours !== SANS_EXPIRATION);
  if (courante !== null && courante !== SANS_EXPIRATION && !durees.includes(courante)) durees.push(courante);
  return [...durees.sort((a, b) => a - b), SANS_EXPIRATION];
}
