import { timingSafeEqual } from "node:crypto";

/**
 * Tâches du serveur (/api/taches) : l'en-tête Authorization présenté porte-t-il PORTAL_TASK_TOKEN ? Comparaison en temps
 * constant ; sans jeton configuré, tout appel est refusé.
 */
export function jetonDeTacheValide(presente: string | null): boolean {
  const attendu = process.env.PORTAL_TASK_TOKEN;
  if (!presente || !attendu) return false;
  const [a, b] = [Buffer.from(presente), Buffer.from(`Bearer ${attendu}`)];
  return a.length === b.length && timingSafeEqual(a, b);
}
