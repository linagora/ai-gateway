import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeMailer } from "@/test/fake-mailer";
import { listAudit } from "./audit";
import { addIntegrationKey, createIntegration, listIntegrations, removeIntegrationKey, setIntegrationActive, updateIntegration } from "./integrations";

/*
 * Registre des intégrations (spécification #71, ticket #74) : tenu par les admins ; chaque changement est inscrit au
 * journal d'audit et annoncé par courriel à tous les admins.
 */
const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const collaborateur = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };
const ADMINS = ["jdupont@linagora.com", "mmaudet@linagora.com"];

let mailer: FakeMailer;
let deps: { db: typeof testDb; mailer: FakeMailer; adminEmails: string[]; portalUrl: string };

beforeEach(async () => {
  await resetDb();
  mailer = new FakeMailer();
  deps = { db: testDb, mailer, adminEmails: ADMINS, portalUrl: "https://portail.test" };
});

const teamManager = { id: "team-manager", name: "Team Manager", scopes: ["lecture", "demandes"] as const, ipRanges: ["203.0.113.10", "2001:db8::/32"], rateLimitPerMinute: 120 };
const pem = (cle: { export: (o: { type: "spki"; format: "pem" }) => string | Buffer }) => cle.export({ type: "spki", format: "pem" }).toString();
const ed25519 = () => pem(generateKeyPairSync("ed25519").publicKey);
const rsa = (bits: number) => pem(generateKeyPairSync("rsa", { modulusLength: bits }).publicKey);

describe("registre des intégrations", () => {
  test("un admin déclare une intégration : elle est créée désactivée, inscrite au journal d'audit et annoncée à tous les admins", async () => {
    await createIntegration(deps, admin, { ...teamManager, scopes: [...teamManager.scopes] });
    expect(await listIntegrations(deps, admin)).toEqual([
      expect.objectContaining({ id: "team-manager", name: "Team Manager", scopes: ["lecture", "demandes"], ipRanges: ["203.0.113.10", "2001:db8::/32"], rateLimitPerMinute: 120, active: false, createdBy: "jdupont", keys: [] }),
    ]);
    expect((await listAudit(testDb)).map((e) => [e.action, e.actorUid, e.targetId])).toEqual([["INTEGRATION_CREATED", "jdupont", "team-manager"]]);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0].to.sort()).toEqual([...ADMINS].sort());
    expect(mailer.outbox[0].subject).toContain("Team Manager");
    expect(mailer.outbox[0].text).toContain("https://portail.test/gestion/integrations");
  });

  test("un identifiant mal formé ou déjà pris est refusé ; il ne change jamais", async () => {
    for (const id of ["Team Manager", "t", "-team", "team_manager", "a".repeat(41)]) {
      await expect(createIntegration(deps, admin, { ...teamManager, scopes: [], id })).rejects.toMatchObject({ code: "integration_invalide", params: { champ: "identifiant" } });
    }
    await createIntegration(deps, admin, { ...teamManager, scopes: [] });
    await expect(createIntegration(deps, admin, { ...teamManager, scopes: [], name: "Autre" })).rejects.toMatchObject({ code: "integration_existante" });
    const modification = { name: "Team Manager (plateforme)", scopes: ["lecture"], ipRanges: ["198.51.100.0/24"], rateLimitPerMinute: 60 };
    await updateIntegration(deps, admin, "team-manager", modification);
    expect(await listIntegrations(deps, admin)).toEqual([
      expect.objectContaining({ id: "team-manager", name: "Team Manager (plateforme)", scopes: ["lecture"], ipRanges: ["198.51.100.0/24"], rateLimitPerMinute: 60 }),
    ]);
    expect(mailer.outbox.at(-1)?.text).toContain("198.51.100.0/24");
    // Enregistrer sans rien changer n'inscrit rien et n'envoie rien.
    await updateIntegration(deps, admin, "team-manager", modification);
    expect((await listAudit(testDb)).map((e) => e.action)).toEqual(["INTEGRATION_CREATED", "INTEGRATION_UPDATED"]);
    expect(mailer.outbox).toHaveLength(2);
    await expect(updateIntegration(deps, admin, "inconnue", modification)).rejects.toMatchObject({ code: "introuvable", params: { objet: "integration" } });
  });

  test("une adresse, une plage CIDR, un nom, un périmètre ou un plafond invalide est refusé", async () => {
    const creer = (changements: object) => createIntegration(deps, admin, { ...teamManager, scopes: [...teamManager.scopes], ...changements });
    for (const adresse of ["203.0.113.300", "203.0.113.0/33", "2001:db8::/129", "exemple.org", "10.0.0.1/abc"]) {
      await expect(creer({ ipRanges: [adresse] })).rejects.toMatchObject({ code: "integration_invalide", params: { champ: "adresses", valeur: adresse } });
    }
    await expect(creer({ name: "  " })).rejects.toMatchObject({ code: "integration_invalide", params: { champ: "nom" } });
    await expect(creer({ scopes: ["admin"] })).rejects.toMatchObject({ code: "integration_invalide", params: { champ: "perimetres" } });
    for (const plafond of [0, 10_001, 1.5]) await expect(creer({ rateLimitPerMinute: plafond })).rejects.toMatchObject({ code: "integration_invalide", params: { champ: "plafond" } });
    expect(await listIntegrations(deps, admin)).toEqual([]);
  });

  test("clés publiques : Ed25519 pour EdDSA, RSA d'au moins 2048 bits pour RS256 ; une clé invalide, privée, d'un autre algorithme ou un kid déjà pris est refusé ; une clé se met hors service", async () => {
    await createIntegration(deps, admin, { ...teamManager, scopes: [...teamManager.scopes] });
    await addIntegrationKey(deps, admin, "team-manager", { kid: "tm-2026-09", algorithm: "EdDSA", publicKeyPem: ed25519() });
    await addIntegrationKey(deps, admin, "team-manager", { kid: "tm-rsa", algorithm: "RS256", publicKeyPem: rsa(2048) });
    const refus = (cle: { kid: string; algorithm: string; publicKeyPem: string }, raison: string) =>
      expect(addIntegrationKey(deps, admin, "team-manager", cle)).rejects.toMatchObject({ code: "cle_publique_invalide", params: { raison } });
    await refus({ kid: "k1", algorithm: "EdDSA", publicKeyPem: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----" }, "format");
    await refus({ kid: "k2", algorithm: "RS256", publicKeyPem: ed25519() }, "algorithme");
    await refus({ kid: "k3", algorithm: "EdDSA", publicKeyPem: rsa(2048) }, "algorithme");
    await refus({ kid: "k4", algorithm: "RS256", publicKeyPem: rsa(1024) }, "taille");
    await refus({ kid: "k5", algorithm: "HS256", publicKeyPem: ed25519() }, "algorithme");
    await refus({ kid: "k6", algorithm: "EdDSA", publicKeyPem: generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, "cle_privee");
    await refus({ kid: "avec espace", algorithm: "EdDSA", publicKeyPem: ed25519() }, "kid");
    await expect(addIntegrationKey(deps, admin, "team-manager", { kid: "tm-2026-09", algorithm: "EdDSA", publicKeyPem: ed25519() })).rejects.toMatchObject({ code: "kid_existant" });

    const [integration] = await listIntegrations(deps, admin);
    expect(integration.keys.map((k) => [k.kid, k.algorithm, k.createdBy])).toEqual([["tm-2026-09", "EdDSA", "jdupont"], ["tm-rsa", "RS256", "jdupont"]]);
    expect(integration.keys[0].fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    // Le courriel aux admins donne l'empreinte de la clé, à comparer avec celle de l'intégrateur.
    expect(mailer.outbox[1].text).toContain(integration.keys[0].fingerprint);
    await removeIntegrationKey(deps, admin, "team-manager", "tm-rsa");
    const [apres] = await listIntegrations(deps, admin);
    expect(apres.keys.map((k) => k.kid)).toEqual(["tm-2026-09"]);
    expect(apres.removedKeys.map((k) => [k.kid, k.removedBy])).toEqual([["tm-rsa", "jdupont"]]);
    await expect(removeIntegrationKey(deps, admin, "team-manager", "tm-rsa")).rejects.toMatchObject({ code: "introuvable", params: { objet: "cle_integration" } });
    // Le kid d'une clé hors service ne resert pas.
    await expect(addIntegrationKey(deps, admin, "team-manager", { kid: "tm-rsa", algorithm: "RS256", publicKeyPem: rsa(2048) })).rejects.toMatchObject({ code: "kid_existant" });
    expect((await listAudit(testDb)).map((e) => [e.action, e.details.kid ?? null])).toEqual([
      ["INTEGRATION_CREATED", null],
      ["INTEGRATION_KEY_ADDED", "tm-2026-09"],
      ["INTEGRATION_KEY_ADDED", "tm-rsa"],
      ["INTEGRATION_KEY_REMOVED", "tm-rsa"],
    ]);
    expect(mailer.outbox).toHaveLength(4);
  });

  test("activation et désactivation, sans suppression possible ; les intégrations actives viennent d'abord", async () => {
    await createIntegration(deps, admin, { ...teamManager, scopes: [...teamManager.scopes] });
    await createIntegration(deps, admin, { ...teamManager, id: "annuaire", name: "Annuaire", scopes: [] });
    await setIntegrationActive(deps, admin, "team-manager", true);
    expect((await listIntegrations(deps, admin)).map((i) => [i.id, i.active])).toEqual([["team-manager", true], ["annuaire", false]]);
    await setIntegrationActive(deps, admin, "team-manager", false);
    expect((await listIntegrations(deps, admin)).map((i) => [i.id, i.active])).toEqual([["annuaire", false], ["team-manager", false]]);
    expect((await listAudit(testDb)).map((e) => e.action).slice(-2)).toEqual(["INTEGRATION_ACTIVATED", "INTEGRATION_DEACTIVATED"]);
    await expect(setIntegrationActive(deps, admin, "inconnue", true)).rejects.toMatchObject({ code: "introuvable", params: { objet: "integration" } });
    expect(mailer.outbox).toHaveLength(4);
  });

  test("réservé aux admins", async () => {
    await createIntegration(deps, admin, { ...teamManager, scopes: [...teamManager.scopes] });
    await expect(listIntegrations(deps, collaborateur)).rejects.toMatchObject({ code: "interdit" });
    await expect(createIntegration(deps, collaborateur, { ...teamManager, id: "autre", scopes: [] })).rejects.toMatchObject({ code: "interdit" });
    await expect(setIntegrationActive(deps, collaborateur, "team-manager", true)).rejects.toMatchObject({ code: "interdit" });
    await expect(addIntegrationKey(deps, collaborateur, "team-manager", { kid: "k", algorithm: "EdDSA", publicKeyPem: ed25519() })).rejects.toMatchObject({ code: "interdit" });
  });
});
