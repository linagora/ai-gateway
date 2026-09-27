import { BlockList, isIP } from "node:net";

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

/**
 * Adresse de l'appelant comprise dans les adresses et plages d'une intégration ; une adresse absente ou illisible ne
 * l'est jamais. Une adresse IPv4 écrite en IPv6 (::ffff:203.0.113.10) vaut l'adresse IPv4.
 */
export function adresseAutorisee(adresse: string | null, plages: readonly string[]): boolean {
  const version = adresse ? isIP(adresse) : 0;
  if (!adresse || version === 0) return false;
  const liste = new BlockList();
  for (const plage of plages.filter(estAdresseOuPlage)) {
    const [base, prefixe] = plage.split("/");
    const type = isIP(base) === 4 ? "ipv4" : "ipv6";
    if (prefixe === undefined) liste.addAddress(base, type);
    else liste.addSubnet(base, Number(prefixe), type);
  }
  return liste.check(adresse, version === 4 ? "ipv4" : "ipv6");
}
