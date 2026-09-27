import { execFileSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, type APIResponse, expect, type Page } from "@playwright/test";
import type { Personne } from "./outils";

/** API d'intégration par le Caddy de dev, qui transmet au portail l'adresse de l'appelant, comme en production. */
export const API = "http://127.0.0.1:54600/api/v1";

/** Intégration « demo » de l'environnement de dev (dev/integration-demo.mjs). */
export const DEMO = { id: "demo", kid: "demo-1" };

/** Déclare, ou remet en état, l'intégration « demo » dans la base portal de dev ; crée sa clé privée au premier usage. */
export function installerDemo(): void {
  execFileSync(process.execPath, [join(__dirname, "..", "dev", "integration-demo.mjs"), "installer"], { stdio: "pipe" });
}

/** Clé privée de l'intégration « demo » (hors dépôt), créée par installerDemo. */
export function cleDemo(): KeyObject {
  return createPrivateKey(readFileSync(join(__dirname, "..", "dev", ".integration-demo", "cle-privee.pem")));
}

/** Jeton d'intégration : l'en-tête (algorithme, identifiant de clé) et les revendications, signés par la clé privée. */
export function signerJeton(revendications: object, { cle, kid, alg = "EdDSA" }: { cle: KeyObject; kid: string; alg?: "EdDSA" | "RS256" }): string {
  const base64url = (valeur: object) => Buffer.from(JSON.stringify(valeur)).toString("base64url");
  const aSigner = `${base64url({ alg, typ: "JWT", kid })}.${base64url(revendications)}`;
  return `${aSigner}.${sign(alg === "RS256" ? "sha256" : null, Buffer.from(aSigner), cle).toString("base64url")}`;
}

/** Jeton de cinq minutes de l'intégration « demo » pour un collaborateur, émis à `maintenant`. */
export function jetonDemo({ uid, email, name }: Personne, maintenant = new Date()): string {
  const iat = Math.floor(maintenant.getTime() / 1000);
  return signerJeton({ iss: DEMO.id, aud: "ai-gateway", sub: uid, email, name, iat, exp: iat + 300 }, { cle: cleDemo(), kid: DEMO.kid });
}

/** Appel de l'API (GET par défaut), avec un jeton, une langue, un corps JSON et des en-têtes supplémentaires. */
export function appeler(
  request: APIRequestContext,
  chemin: string,
  options: { jeton?: string; langue?: string; entetes?: Record<string, string>; methode?: "GET" | "POST" | "PUT"; corps?: unknown } = {},
): Promise<APIResponse> {
  return request.fetch(`${API}${chemin}`, {
    method: options.methode ?? "GET",
    data: options.corps,
    headers: {
      ...(options.jeton ? { Authorization: `Bearer ${options.jeton}` } : {}),
      ...(options.langue ? { "Accept-Language": options.langue } : {}),
      ...options.entetes,
    },
  });
}

/** Erreur rendue par l'API : son statut, son code, son message et ses détails ; elle n'est jamais mise en cache. */
export async function erreur(reponse: APIResponse): Promise<{ statut: number; code: string; message: string; details: Record<string, unknown> }> {
  expect(reponse.headers()["cache-control"]).toBe("no-store");
  const { error } = (await reponse.json()) as { error: { code: string; message: string; details: Record<string, unknown> } };
  return { statut: reponse.status(), ...error };
}

/** Utilisateur de la passerelle de dev (null s'il n'existe pas), lu par l'API d'administration de LiteLLM. */
export async function utilisateurPasserelle(uid: string): Promise<{ user_email: string | null } | null> {
  const reponse = await fetch(`http://127.0.0.1:54400/admin/user/info?user_id=${encodeURIComponent(uid)}`, { headers: { Authorization: "Bearer sk-dev-master-key" } });
  if (reponse.status === 404) return null;
  return ((await reponse.json()) as { user_info: { user_email: string | null } }).user_info;
}

/** Intégration de test déclarée dans l'onglet, avec une clé Ed25519 : de quoi signer ses jetons. */
export interface IntegrationDeTest {
  id: string;
  nom: string;
  jeton: (collaborateur: Personne) => string;
}

type Perimetre = "Lecture" | "Demandes" | "Clés";

/** L'admin déclare une intégration dans l'onglet « Intégrations » et lui ajoute une clé publique ; elle reste désactivée. */
export async function declarerIntegration(
  admin: Page,
  reglages: { id: string; nom: string; perimetres: Perimetre[]; adresses: string[]; plafond: number },
): Promise<IntegrationDeTest> {
  await admin.goto("/gestion/integrations");
  const declaration = admin.getByRole("form", { name: "Déclarer une intégration" });
  await declaration.getByLabel("Identifiant").fill(reglages.id);
  await declaration.getByLabel("Nom").fill(reglages.nom);
  for (const perimetre of reglages.perimetres) await declaration.getByRole("checkbox", { name: new RegExp(`^${perimetre}`) }).check();
  await declaration.getByLabel("Adresses IP et plages CIDR").fill(reglages.adresses.join("\n"));
  await declaration.getByLabel("Plafond (requêtes par minute)").fill(String(reglages.plafond));
  await declaration.getByRole("button", { name: "Déclarer l'intégration" }).click();
  await expect(admin.getByRole("status")).toHaveText(/^Intégration déclarée/);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const cle = admin.getByRole("region", { name: reglages.nom }).getByRole("form", { name: `Ajouter une clé publique ${reglages.nom}` });
  await cle.getByLabel("Identifiant de clé (kid)").fill("cle-1");
  await cle.getByLabel("Clé publique (PEM)").fill(publicKey.export({ type: "spki", format: "pem" }).toString());
  await cle.getByRole("button", { name: "Ajouter la clé" }).click();
  await expect(admin.getByRole("status")).toHaveText("Clé publique ajoutée.");
  return {
    id: reglages.id,
    nom: reglages.nom,
    jeton: ({ uid, email, name }) => {
      const iat = Math.floor(Date.now() / 1000);
      return signerJeton({ iss: reglages.id, aud: "ai-gateway", sub: uid, email, name, iat, exp: iat + 300 }, { cle: privateKey, kid: "cle-1" });
    },
  };
}

/** L'admin règle le périmètre ou les adresses d'une intégration dans l'onglet. */
export async function reglerIntegration(admin: Page, integration: IntegrationDeTest, { perimetres, adresses }: { perimetres?: Perimetre[]; adresses?: string[] }): Promise<void> {
  await admin.goto(`/gestion/integrations?integration=${integration.id}`);
  const reglages = admin.getByRole("region", { name: integration.nom }).getByRole("form", { name: `Réglages ${integration.nom}` });
  if (perimetres) {
    for (const perimetre of ["Lecture", "Demandes", "Clés"] as const) {
      await reglages.getByRole("checkbox", { name: new RegExp(`^${perimetre}`) }).setChecked(perimetres.includes(perimetre));
    }
  }
  if (adresses) await reglages.getByLabel("Adresses IP et plages CIDR").fill(adresses.join("\n"));
  await reglages.getByRole("button", { name: "Enregistrer" }).click();
  await expect(admin.getByRole("status")).toHaveText("Intégration enregistrée.");
}

/** L'admin active ou désactive une intégration dans l'onglet. */
export async function basculerIntegration(admin: Page, integration: IntegrationDeTest, action: "Activer" | "Désactiver"): Promise<void> {
  await admin.goto(`/gestion/integrations?integration=${integration.id}`);
  await admin.getByRole("region", { name: integration.nom }).getByRole("button", { name: action, exact: true }).click();
  await expect(admin.getByRole("status")).toHaveText(action === "Activer" ? "Intégration activée." : "Intégration désactivée : ses appels sont refusés.");
}
