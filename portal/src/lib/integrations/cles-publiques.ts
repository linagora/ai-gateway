import { createHash, createPublicKey, type KeyObject } from "node:crypto";

/** Algorithmes de signature des jetons d'intégration (ADR 0003) : EdDSA avec une clé Ed25519, ou RS256 en repli. */
export const ALGORITHMES = ["EdDSA", "RS256"] as const;
export type Algorithme = (typeof ALGORITHMES)[number];

/** Motif du refus d'une clé publique. */
export type RaisonRefus = "format" | "algorithme" | "taille" | "cle_privee";

/** Type de clé qu'exige chaque algorithme (Node.js, `asymmetricKeyType`). */
const TYPE_DE_CLE: Record<Algorithme, string> = { EdDSA: "ed25519", RS256: "rsa" };

/** Taille minimale d'une clé RSA, en bits. */
const RSA_MINIMUM = 2048;

/** Longueur au-delà de laquelle un texte ne peut pas être une clé publique (une clé RSA de 8 192 bits en PEM en compte moins de 1 500). */
const LONGUEUR_MAXIMALE = 10_000;

/**
 * Contrôle une clé publique transmise au format PEM pour l'algorithme déclaré : rend sa forme normalisée (PEM SPKI), ou le
 * motif de son refus. Une clé privée est refusée : le portail n'en reçoit jamais.
 */
export function lireClePublique(algorithme: string, pem: string): { ok: true; publicKeyPem: string } | { ok: false; raison: RaisonRefus } {
  if (!(ALGORITHMES as readonly string[]).includes(algorithme)) return { ok: false, raison: "algorithme" };
  // createPublicKey accepte aussi une clé privée, dont il tire la clé publique : elle est refusée avant toute lecture.
  if (pem.includes("PRIVATE KEY")) return { ok: false, raison: "cle_privee" };
  let cle: KeyObject;
  try {
    if (pem.length > LONGUEUR_MAXIMALE) throw new Error("texte trop long");
    cle = createPublicKey({ key: pem, format: "pem" });
  } catch {
    return { ok: false, raison: "format" };
  }
  if (cle.asymmetricKeyType !== TYPE_DE_CLE[algorithme as Algorithme]) return { ok: false, raison: "algorithme" };
  if (cle.asymmetricKeyType === "rsa" && (cle.asymmetricKeyDetails?.modulusLength ?? 0) < RSA_MINIMUM) return { ok: false, raison: "taille" };
  return { ok: true, publicKeyPem: cle.export({ type: "spki", format: "pem" }).toString() };
}

/**
 * Empreinte d'une clé publique, que l'admin compare avec celle de l'intégrateur : « SHA256: » suivi du condensé SHA-256
 * de la clé (DER SPKI) en base64 sans remplissage, comme OpenSSH.
 */
export function empreinte(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64").replace(/=+$/, "")}`;
}
