import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { type EmetteurDeJetons, verifierJeton } from "./jeton";

/*
 * Vérification du jeton d'intégration (spécification #71, ADR 0003) : signé par une clé enregistrée et en service de
 * son intégration, avec l'algorithme de cette clé, pour le portail, d'une durée de cinq minutes au plus, avec une
 * tolérance d'horloge de trente secondes. Il rend un collaborateur, jamais un admin, qui porte le canal de l'intégration.
 */
const ed25519 = generateKeyPairSync("ed25519");
const autreEd25519 = generateKeyPairSync("ed25519");
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (cle: KeyObject) => cle.export({ type: "spki", format: "pem" }).toString();

const teamManager: EmetteurDeJetons = {
  id: "team-manager",
  keys: [
    { kid: "tm-1", algorithm: "EdDSA", publicKeyPem: pem(ed25519.publicKey) },
    { kid: "tm-rsa", algorithm: "RS256", publicKeyPem: pem(rsa.publicKey) },
  ],
};
const emetteur = async (id: string) => (id === teamManager.id ? teamManager : null);

const maintenant = new Date("2026-09-28T10:00:00Z");
const secondes = Math.floor(maintenant.getTime() / 1000);
const revendications = { iss: "team-manager", aud: "ai-gateway", sub: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", iat: secondes, exp: secondes + 300 };

/** Revendications valides, sauf celle nommée. */
const sans = (nom: string) => Object.fromEntries(Object.entries(revendications).filter(([cle]) => cle !== nom));

const b64 = (valeur: unknown) => Buffer.from(typeof valeur === "string" ? valeur : JSON.stringify(valeur)).toString("base64url");

/** Jeton signé : Ed25519 par défaut, RS256 avec une clé RSA, ou un en-tête et une signature fabriqués. */
function jeton(charge: object = revendications, { alg = "EdDSA", kid = "tm-1", cle = ed25519.privateKey as KeyObject | null, signature }: { alg?: string; kid?: string; cle?: KeyObject | null; signature?: string } = {}) {
  const aSigner = `${b64({ alg, typ: "JWT", kid })}.${b64(charge)}`;
  const signe = signature ?? (cle ? sign(alg === "RS256" ? "sha256" : null, Buffer.from(aSigner), cle).toString("base64url") : "");
  return `Bearer ${aSigner}.${signe}`;
}

const verifier = (autorisation: string | null, options: { a?: Date } = {}) => verifierJeton(autorisation, { emetteur, audience: "ai-gateway", maintenant: options.a ?? maintenant });
const refus = async (autorisation: string | null, raison: string, revendication?: string) =>
  expect(await verifier(autorisation)).toEqual({ ok: false, raison, ...(revendication ? { revendication } : {}) });

describe("jeton d'intégration", () => {
  test("un jeton valide rend le collaborateur, jamais admin, avec le canal de l'intégration", async () => {
    const attendu = { ok: true, emetteur: teamManager, acteur: { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false, canal: "team-manager" } };
    expect(await verifier(jeton())).toEqual(attendu);
    // RS256 avec la clé RSA enregistrée ; un destinataire donné en liste est admis.
    expect(await verifier(jeton(revendications, { alg: "RS256", kid: "tm-rsa", cle: rsa.privateKey }))).toEqual(attendu);
    expect(await verifier(jeton({ ...revendications, aud: ["autre", "ai-gateway"] }))).toEqual(attendu);
    // Un admin du portail qui passe par une intégration n'a que les droits d'un collaborateur.
    expect(await verifier(jeton({ ...revendications, sub: "mmaudet", isAdmin: true, role: "admin" }))).toMatchObject({ ok: true, acteur: { uid: "mmaudet", isAdmin: false } });
  });

  test("un jeton absent ou illisible est refusé", async () => {
    await refus(null, "absent");
    await refus("Basic cG1hcnRpbjpzZWNyZXQ=", "absent");
    await refus("Bearer abc", "illisible");
    await refus(`Bearer ${b64("pas du JSON")}.${b64(revendications)}.c2ln`, "illisible");
    await refus(`Bearer ${"a".repeat(9000)}.${b64(revendications)}.c2ln`, "illisible");
  });

  test("une intégration inconnue, ou une clé inconnue ou hors service, est refusée", async () => {
    await refus(jeton({ ...revendications, iss: "inconnue" }), "integration_inconnue");
    await refus(jeton(revendications, { kid: "tm-hors-service" }), "cle_inconnue");
  });

  test("une signature falsifiée, ou faite par une autre clé, est refusée", async () => {
    const [entete, , signature] = jeton().slice("Bearer ".length).split(".");
    await refus(`Bearer ${entete}.${b64({ ...revendications, sub: "mmaudet" })}.${signature}`, "signature");
    await refus(jeton(revendications, { cle: autreEd25519.privateKey }), "signature");
    await refus(jeton(revendications, { signature: "" }), "signature");
  });

  test("seul l'algorithme de la clé enregistrée est admis : ni none, ni HS256 signé avec la clé publique, ni RS256 pour une clé Ed25519", async () => {
    await refus(jeton(revendications, { alg: "none", cle: null }), "algorithme");
    const aSigner = `${b64({ alg: "HS256", typ: "JWT", kid: "tm-rsa" })}.${b64(revendications)}`;
    const hmac = createHmac("sha256", pem(rsa.publicKey)).update(aSigner).digest("base64url");
    await refus(`Bearer ${aSigner}.${hmac}`, "algorithme");
    await refus(jeton(revendications, { alg: "RS256", kid: "tm-1", cle: rsa.privateKey }), "algorithme");
    await refus(jeton(revendications, { alg: "EdDSA", kid: "tm-rsa" }), "algorithme");
  });

  test("le destinataire doit être le portail", async () => {
    await refus(jeton({ ...revendications, aud: "autre-service" }), "destinataire");
    await refus(jeton(sans("aud")), "destinataire");
  });

  test("cinq minutes au plus, avec trente secondes de tolérance d'horloge", async () => {
    // Expiré depuis plus de trente secondes, ou depuis moins.
    await refus(jeton({ ...revendications, iat: secondes - 331, exp: secondes - 31 }), "expire");
    expect(await verifier(jeton({ ...revendications, iat: secondes - 329, exp: secondes - 29 }))).toMatchObject({ ok: true });
    // Émis dans le futur, au-delà de la tolérance ou en deçà.
    await refus(jeton({ ...revendications, iat: secondes + 31, exp: secondes + 331 }), "futur");
    expect(await verifier(jeton({ ...revendications, iat: secondes + 29, exp: secondes + 329 }))).toMatchObject({ ok: true });
    await refus(jeton({ ...revendications, nbf: secondes + 60 }), "futur");
    // Plus de cinq minutes de validité.
    await refus(jeton({ ...revendications, exp: secondes + 301 }), "duree");
    await refus(jeton({ ...revendications, exp: secondes - 1 }), "duree");
  });

  test("sub, email, name, iat et exp sont exigés et bornés", async () => {
    for (const revendication of ["sub", "email", "name", "iat", "exp"]) await refus(jeton(sans(revendication)), "revendication", revendication);
    await refus(jeton({ ...revendications, sub: "pmartin; drop" }), "revendication", "sub");
    await refus(jeton({ ...revendications, sub: "a".repeat(129) }), "revendication", "sub");
    await refus(jeton({ ...revendications, email: "pas une adresse" }), "revendication", "email");
    await refus(jeton({ ...revendications, name: "   " }), "revendication", "name");
    await refus(jeton({ ...revendications, iat: "maintenant" }), "revendication", "iat");
  });
});
