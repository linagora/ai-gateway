#!/usr/bin/env node
/**
 * Intégration « demo » de l'environnement de développement (spécification #71) : une paire de clés Ed25519, créée au
 * premier usage dans dev/.integration-demo/ (hors dépôt), et l'intégration déclarée, active, dans la base portal de dev,
 * avec tous les périmètres et les adresses locales et privées (le Caddy de dev voit les appels venir du réseau de
 * Docker). Valeurs de DÉVELOPPEMENT seulement.
 *
 *   node dev/integration-demo.mjs installer
 *   node dev/integration-demo.mjs jeton <uid> [<adresse> [<nom>]]
 *
 * Par exemple, par le Caddy de dev qui, comme en production, transmet au portail l'adresse de l'appelant :
 *   curl -H "Authorization: Bearer $(node dev/integration-demo.mjs jeton jdupont)" http://127.0.0.1:54600/api/v1/me/teams
 */
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ICI = dirname(fileURLToPath(import.meta.url));
const FICHIER_CLE = join(ICI, ".integration-demo", "cle-privee.pem");

/** Identifiant de l'intégration, identifiant de sa clé et destinataire de ses jetons (repris par e2e/api.ts). */
const DEMO = { id: "demo", kid: "demo-1", audience: "ai-gateway" };

/** Clé privée de l'intégration « demo », créée au premier usage, lisible du seul utilisateur. */
function cleDemo() {
  if (!existsSync(FICHIER_CLE)) {
    mkdirSync(dirname(FICHIER_CLE), { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(FICHIER_CLE, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  return createPrivateKey(readFileSync(FICHIER_CLE));
}

/** Jeton de cinq minutes de l'intégration « demo » pour un collaborateur, signé en EdDSA. */
function jetonDemo({ uid, email = `${uid}@example.org`, name = uid }) {
  const iat = Math.floor(Date.now() / 1000);
  const base64url = (valeur) => Buffer.from(JSON.stringify(valeur)).toString("base64url");
  const aSigner = `${base64url({ alg: "EdDSA", typ: "JWT", kid: DEMO.kid })}.${base64url({ iss: DEMO.id, aud: DEMO.audience, sub: uid, email, name, iat, exp: iat + 300 })}`;
  return `${aSigner}.${sign(null, Buffer.from(aSigner), cleDemo()).toString("base64url")}`;
}

/** Déclare, ou remet en état, l'intégration « demo » et sa clé publique dans la base portal de dev. Idempotent. */
function installerDemo() {
  const pem = createPublicKey(cleDemo()).export({ type: "spki", format: "pem" }).toString();
  const sql = `
    insert into "Integration" (id, name, scopes, "ipRanges", "rateLimitPerMinute", active, "createdBy", "updatedAt")
    values ('${DEMO.id}', 'Démo (développement)', '{LECTURE,DEMANDES,CLES}', '{127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}', 600, true, 'dev', now())
    on conflict (id) do update set scopes = excluded.scopes, "ipRanges" = excluded."ipRanges",
      "rateLimitPerMinute" = excluded."rateLimitPerMinute", active = true, "updatedAt" = now();
    insert into "IntegrationKey" (id, "integrationId", kid, algorithm, "publicKeyPem", "createdBy")
    values ('${DEMO.kid}', '${DEMO.id}', '${DEMO.kid}', 'EdDSA', '${pem}', 'dev')
    on conflict ("integrationId", kid) do update set "publicKeyPem" = excluded."publicKeyPem", "removedAt" = null, "removedBy" = null;`;
  const compose = ["compose", "-f", join(ICI, "docker-compose.yml"), "exec", "-T", "postgres"];
  execFileSync("docker", [...compose, "psql", "-U", "postgres", "-d", "portal", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { stdio: "pipe" });
}

const [commande, uid, email, name] = process.argv.slice(2);
if (commande === "installer") {
  installerDemo();
  console.log("Intégration « demo » active dans la base portal de dev ; clé privée : dev/.integration-demo/ (hors dépôt).");
} else if (commande === "jeton" && uid) {
  console.log(jetonDemo({ uid, email, name }));
} else {
  console.error("Usage : node dev/integration-demo.mjs installer | jeton <uid> [<adresse> [<nom>]]");
  process.exitCode = 1;
}
