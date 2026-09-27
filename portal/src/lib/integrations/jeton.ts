import { createPublicKey, verify } from "node:crypto";
import type { SessionUser } from "@/lib/auth-user";
import type { Algorithme } from "./cles-publiques";

/**
 * Vérification du jeton d'intégration (spécification #71, ADR 0003) : un JWT signé par l'intégration avec la clé privée
 * d'une de ses clés publiques enregistrées, qui dit quel collaborateur agit par elle. Sans état : l'intégration et ses
 * clés en service sont lues par `emetteur`, l'horloge est injectée.
 */

/** Clé publique en service d'une intégration. */
export interface CleDeVerification {
  kid: string;
  algorithm: Algorithme;
  publicKeyPem: string;
}

/** Intégration telle que la voit la vérification : son identifiant (`iss` de ses jetons) et ses clés en service. */
export interface EmetteurDeJetons {
  id: string;
  keys: CleDeVerification[];
}

/** Motif d'un refus (réponse 401, `details.reason`). */
export type MotifDeRefus =
  | "absent"
  | "illisible"
  | "integration_inconnue"
  | "cle_inconnue"
  | "algorithme"
  | "signature"
  | "destinataire"
  | "expire"
  | "futur"
  | "duree"
  | "revendication";

/** Jeton accepté : l'intégration telle que l'a lue `emetteur`, et le collaborateur qui agit par elle ; ou le motif du refus. */
export type Verification<E extends EmetteurDeJetons = EmetteurDeJetons> =
  | { ok: true; emetteur: E; acteur: SessionUser }
  | { ok: false; motif: MotifDeRefus; revendication?: string };

/** Durée de validité maximale d'un jeton : `exp` au plus cinq minutes après `iat`. */
const DUREE_MAXIMALE_S = 300;
/** Tolérance d'horloge entre l'intégration et le portail. */
const TOLERANCE_S = 30;
/** Longueur maximale d'un jeton, en caractères. */
const LONGUEUR_MAXIMALE = 8192;
/** uid LDAP : lettres, chiffres, points, tirets, soulignés et arobases, 128 caractères au plus. */
const UID = /^[A-Za-z0-9._@-]{1,128}$/;
const ADRESSE = /^[^\s@]+@[^\s@]+$/;

type Revendications = Record<string, unknown>;

/**
 * Vérifie l'en-tête `Authorization: Bearer <jeton>` : intégration connue (`iss`), clé en service (`kid`), algorithme de
 * cette clé, signature, destinataire (`aud`), durée et dates (`iat`, `exp`, `nbf`), identité (`sub`, `email`, `name`).
 * Rend le collaborateur, jamais admin quels que soient ses rôles dans le portail, avec le canal de l'intégration.
 */
export async function verifierJeton<E extends EmetteurDeJetons>(
  autorisation: string | null,
  options: { emetteur: (id: string) => Promise<E | null>; audience: string; maintenant: Date },
): Promise<Verification<E>> {
  const refus = (motif: MotifDeRefus, revendication?: string): Verification<E> => ({ ok: false, motif, ...(revendication ? { revendication } : {}) });
  const porteur = /^Bearer (\S+)$/.exec(autorisation?.trim() ?? "")?.[1];
  if (!porteur) return refus("absent");
  const parties = porteur.split(".");
  if (porteur.length > LONGUEUR_MAXIMALE || parties.length !== 3 || !parties.every((p) => /^[A-Za-z0-9_-]*$/.test(p))) return refus("illisible");
  const [entete, charge] = [lireJson(parties[0]), lireJson(parties[1])];
  if (!entete || !charge || typeof entete.alg !== "string" || typeof entete.kid !== "string" || "crit" in entete) return refus("illisible");

  const integration = typeof charge.iss === "string" ? await options.emetteur(charge.iss) : null;
  if (!integration) return refus("integration_inconnue");
  const cle = integration.keys.find((k) => k.kid === entete.kid);
  if (!cle) return refus("cle_inconnue");
  // L'algorithme est celui de la clé enregistrée, jamais celui que le jeton annonce (ni none, ni HS256, ni un autre).
  if (entete.alg !== cle.algorithm) return refus("algorithme");
  if (!signatureValide(cle, `${parties[0]}.${parties[1]}`, parties[2])) return refus("signature");

  const destinataires = Array.isArray(charge.aud) ? charge.aud : [charge.aud];
  if (!destinataires.includes(options.audience)) return refus("destinataire");
  const maintenant = options.maintenant.getTime() / 1000;
  for (const date of ["iat", "exp"] as const) if (!Number.isFinite(charge[date])) return refus("revendication", date);
  const [iat, exp] = [charge.iat as number, charge.exp as number];
  if (exp <= iat || exp - iat > DUREE_MAXIMALE_S) return refus("duree");
  if (maintenant > exp + TOLERANCE_S) return refus("expire");
  if (iat > maintenant + TOLERANCE_S) return refus("futur");
  if (charge.nbf !== undefined && (!Number.isFinite(charge.nbf) || (charge.nbf as number) > maintenant + TOLERANCE_S)) return refus("futur");

  const [uid, email, name] = [texte(charge.sub), texte(charge.email), texte(charge.name)];
  if (!uid || !UID.test(uid)) return refus("revendication", "sub");
  if (!email || email.length > 254 || !ADRESSE.test(email)) return refus("revendication", "email");
  if (!name || name.length > 200) return refus("revendication", "name");
  return { ok: true, emetteur: integration, acteur: { uid, email, name, isAdmin: false, canal: integration.id } };
}

function lireJson(base64url: string): Revendications | null {
  try {
    const valeur: unknown = JSON.parse(Buffer.from(base64url, "base64url").toString("utf8"));
    return valeur && typeof valeur === "object" && !Array.isArray(valeur) ? (valeur as Revendications) : null;
  } catch {
    return null;
  }
}

function signatureValide(cle: CleDeVerification, signe: string, signature: string): boolean {
  try {
    // EdDSA : Ed25519 sans condensé préalable ; RS256 : RSASSA-PKCS1-v1_5 avec SHA-256.
    return verify(cle.algorithm === "RS256" ? "sha256" : null, Buffer.from(signe), createPublicKey(cle.publicKeyPem), Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** Texte d'une revendication, sans espaces autour ; null s'il est absent ou vide. */
function texte(valeur: unknown): string | null {
  return typeof valeur === "string" && valeur.trim() ? valeur.trim() : null;
}
