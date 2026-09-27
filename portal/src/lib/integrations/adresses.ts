import { isIP } from "node:net";

/**
 * Adresse IPv4 ou IPv6, ou plage CIDR (l'adresse, une barre oblique et la longueur du préfixe : 32 bits au plus en IPv4,
 * 128 en IPv6), telle qu'un admin la déclare pour une intégration (spécification #71).
 */
export function estAdresseOuPlage(valeur: string): boolean {
  const [adresse, prefixe, ...reste] = valeur.split("/");
  const version = isIP(adresse);
  if (version === 0 || reste.length > 0) return false;
  return prefixe === undefined || (/^\d{1,3}$/.test(prefixe) && Number(prefixe) <= (version === 4 ? 32 : 128));
}
