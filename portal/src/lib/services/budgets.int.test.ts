import { beforeEach, describe, expect, test } from "vitest";
import { ZodError } from "zod";
import type { Traducteur } from "@/lib/integrations/api";
import { vueDemandes } from "@/lib/integrations/vues";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { approveKeyRequest, getRequestReview, listPendingRequests, refuseRequest, requestCompletion } from "./admin-requests";
import { listAudit } from "./audit";
import { approveBudgetRequest, completeBudgetRequest, createBudgetRequest } from "./budgets";
import { saveCatalogEntry } from "./catalog";
import { blockKey, listMyKeys, pickUpKey, replaceKey, revokeKey } from "./keys";
import { cancelRequest, countMyPending, createKeyRequest, type KeyRequestInput, listMyRequests } from "./requests";
import { saveSettings } from "./settings";

const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const titulaire = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: false };
const collegue = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };

const JOUR = 86_400_000;
let maintenant = new Date("2026-10-01T09:00:00Z");

let litellm: FakeLiteLLM;
let mailer: FakeMailer;
let deps: { db: typeof testDb; litellm: FakeLiteLLM; now: () => Date; mailer: FakeMailer; adminEmails: string[]; portalUrl: string };
/** Demande de la clé émise du titulaire, approuvée à 15 € tous les 30 jours, et son empreinte dans la passerelle. */
let cle: string;
let tokenId: string;
let alias: string;

const demande: KeyRequestInput = {
  teamId: "equipe-rd",
  dataLevel: "N2",
  models: ["mistral-small"],
  justification: "Assistant de rédaction",
  project: "Compte-rendu hebdo",
  requestedBudget: 20,
  requestedDays: 90,
  commitment: true,
};

const approbation = { models: ["mistral-small"], budget: 15, budgetDuration: "30d", days: 60, rpmLimit: 100, tpmLimit: null };

/** Clé approuvée à 15 € tous les 30 jours, puis retirée par le titulaire. */
async function cleEmise(input: Partial<KeyRequestInput> = {}): Promise<{ id: string; tokenId: string; alias: string }> {
  const { id } = await createKeyRequest(deps, titulaire, { ...demande, ...input });
  await approveKeyRequest(deps, admin, id, approbation);
  await pickUpKey(deps, titulaire, id);
  const emise = await testDb.accessRequest.findUniqueOrThrow({ where: { id } });
  return { id, tokenId: emise.keyTokenId as string, alias: emise.keyAlias as string };
}

const statut = async (id: string) => (await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).status;
const plafondDeLaCle = async (id: string) => (await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).approvedBudget?.toNumber();
const designerResponsable = (uid: string) => testDb.teamManager.create({ data: { teamId: "equipe-rd", uid, email: `${uid}@linagora.com`, designatedBy: "jdupont" } });

beforeEach(async () => {
  await resetDb();
  maintenant = new Date("2026-10-01T09:00:00Z");
  litellm = new FakeLiteLLM()
    .withModel({ modelName: "mistral-small" })
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: [], memberUids: ["mmaudet", "pmartin"] });
  litellm.horloge = () => maintenant;
  mailer = new FakeMailer();
  deps = { db: testDb, litellm, now: () => maintenant, mailer, adminEmails: ["admins@linagora.com"], portalUrl: "https://portail.test" };
  const fiche = { shortDescriptionFr: "…", longDescriptionFr: "…", useCases: [], recommendedFor: [], visible: true };
  await saveCatalogEntry(deps, admin, { ...fiche, modelName: "mistral-small", displayNameFr: "Mistral Small", dataLevel: "N2" });
  await saveSettings(deps, admin, { pickup_days: "14", default_budget: "20" });
  ({ id: cle, tokenId, alias } = await cleEmise());
  litellm.keys.get(tokenId)!.spend = 7.5;
  mailer.outbox.splice(0);
});

describe("hausse du budget d'une clé émise", () => {
  test("approuvée, elle relève le plafond de la même clé dans la passerelle, sans toucher à sa dépense, et le garde pour un remplacement", async () => {
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    expect(await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({
      kind: "BUDGET",
      status: "SOUMISE",
      requesterUid: "mmaudet",
      teamId: "equipe-rd",
      teamAlias: "R&D",
      models: [],
      justification: "Lot de contrats",
      raisesBudgetOfRequestId: cle,
    });
    expect((await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).requestedBudget?.toNumber()).toBe(50);
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ actorUid: "mmaudet", action: "BUDGET_REQUESTED", targetId: id, details: { alias, avant: 15, demande: 50 } });
    // Sans responsable dans l'équipe, la demande part aux admins.
    expect(mailer.outbox.map((c) => [c.to, c.subject])).toEqual([
      [["admins@linagora.com"], "[AI GATEWAY] Nouvelle demande de hausse de budget de Michel-Marie Maudet / New budget increase request from Michel-Marie Maudet"],
    ]);
    expect(mailer.outbox[0].text).toContain(`Michel-Marie Maudet (mmaudet@linagora.com) demande une hausse du budget de sa clé d'API ${alias} :`);
    expect(mailer.outbox[0].text).toMatch(/- Plafond actuel : 15,00\s€ par période de 30 jours/);
    expect(mailer.outbox[0].text).toMatch(/- Budget souhaité : 50,00\s€/);
    expect(mailer.outbox[0].text).toContain("- Motif : Lot de contrats");
    expect(mailer.outbox[0].text).toContain(`https://portail.test/gestion/demandes/${id}`);
    mailer.outbox.splice(0);

    const avant = { ...litellm.keys.get(tokenId)! };
    await approveBudgetRequest(deps, admin, id, { budget: 40 });
    expect(litellm.keys.get(tokenId)).toMatchObject({ key: avant.key, spend: 7.5, budgetResetAt: avant.budgetResetAt, expiresAt: avant.expiresAt, maxBudget: 40 });
    expect(await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "APPROUVEE", decidedBy: "jdupont", decidedAt: maintenant });
    expect((await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).approvedBudget?.toNumber()).toBe(40);
    expect(await statut(cle)).toBe("CLE_EMISE");
    expect(await plafondDeLaCle(cle)).toBe(40);
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ actorUid: "jdupont", action: "BUDGET_RAISED", targetId: id, details: { alias, avant: 15, demande: 50, accorde: 40 } });
    // La décision d'un admin ne va qu'aux responsables de l'équipe : il n'y en a pas.
    expect(mailer.outbox.map((c) => [c.to, c.subject])).toEqual([
      [["mmaudet@linagora.com"], `[AI GATEWAY] Le budget de votre clé ${alias} est relevé / The budget of your key ${alias} is raised`],
    ]);
    expect(mailer.outbox[0].text).toMatch(new RegExp(`Le budget de votre clé d'API ${alias} est relevé à 40,00\\s€ par période de 30 jours\\.`));
    expect(mailer.outbox[0].text).toContain("Votre clé ne change pas : continuez de l'utiliser telle quelle. Sa dépense de la période en cours est conservée.");
    expect(mailer.outbox[0].text).toContain("https://portail.test/cles");

    // Une hausse approuvée n'est ni une clé à retirer, ni une demande en cours.
    expect(await countMyPending(deps, titulaire)).toEqual({ clesARetirer: 0, abonnementsADeclarer: 0, demandesACompleter: 0 });
    expect((await listMyKeys(deps, titulaire)).toPickUp).toEqual([]);
    expect(await statut(id)).toBe("APPROUVEE");

    await replaceKey(deps, titulaire, cle);
    expect([...litellm.keys.values()].find((k) => k.alias.endsWith("-2"))?.maxBudget).toBe(40);
  });

  test("le montant demandé, puis accordé, doit dépasser le plafond actuel", async () => {
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 15, justification: "x" })).rejects.toMatchObject({
      code: "budget_trop_bas",
      params: { plafond: "15" },
    });
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "x" });
    await expect(approveBudgetRequest(deps, admin, id, { budget: 15 })).rejects.toMatchObject({ code: "budget_trop_bas" });
    await expect(approveBudgetRequest(deps, admin, id, { budget: -1 })).rejects.toBeInstanceOf(ZodError);
    expect(await statut(id)).toBe("SOUMISE");
    expect(litellm.keys.get(tokenId)?.maxBudget).toBe(15);
  });

  test("le montant demandé, puis accordé, est arrondi au centime ; arrondi au plafond actuel, il ne le dépasse pas", async () => {
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 15.004, justification: "x" })).rejects.toMatchObject({ code: "budget_trop_bas" });
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 20.126, justification: "x" });
    expect((await getRequestReview(deps, admin, id)).requestedBudget).toBe(20.13);
    await expect(approveBudgetRequest(deps, admin, id, { budget: 0.004 })).rejects.toBeInstanceOf(ZodError);

    await approveBudgetRequest(deps, admin, id, { budget: 25.554 });
    expect(litellm.keys.get(tokenId)?.maxBudget).toBe(25.55);
    expect(await plafondDeLaCle(cle)).toBe(25.55);
  });

  test("une clé bloquée peut recevoir une hausse ; elle reste bloquée", async () => {
    await blockKey(deps, admin, cle);
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    await approveBudgetRequest(deps, admin, id, { budget: 50 });
    expect(litellm.keys.get(tokenId)).toMatchObject({ blocked: true, maxBudget: 50 });
  });

  test("la justification est obligatoire, et une seule hausse peut être en cours par clé", async () => {
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "  " })).rejects.toBeInstanceOf(ZodError);
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 60, justification: "Encore" })).rejects.toMatchObject({
      code: "demande_en_cours",
      params: { cas: "hausse" },
    });
    // Décidée, elle n'empêche plus une nouvelle hausse.
    await approveBudgetRequest(deps, admin, id, { budget: 40 });
    await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 60, justification: "Encore" });
  });

  test("seul le titulaire demande une hausse, sur une clé émise et non expirée", async () => {
    await expect(createBudgetRequest(deps, collegue, { keyRequestId: cle, requestedBudget: 50, justification: "x" })).rejects.toMatchObject({
      code: "introuvable",
      params: { objet: "demande_cle" },
    });
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: "inconnue", requestedBudget: 50, justification: "x" })).rejects.toMatchObject({ code: "introuvable" });
    const { id: soumise } = await createKeyRequest(deps, titulaire, demande);
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: soumise, requestedBudget: 50, justification: "x" })).rejects.toMatchObject({ code: "transition_interdite" });

    maintenant = new Date(maintenant.getTime() + 61 * JOUR);
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "x" })).rejects.toMatchObject({
      code: "transition_interdite",
      params: { cas: "expiree" },
    });
    expect(await testDb.accessRequest.count({ where: { kind: "BUDGET" } })).toBe(0);
  });

  test("une clé sans plafond ou sans période n'a pas de budget à relever", async () => {
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "x" });
    await testDb.accessRequest.update({ where: { id: cle }, data: { budgetDuration: null } });
    await expect(approveBudgetRequest(deps, admin, id, { budget: 40 })).rejects.toMatchObject({ code: "transition_interdite" });
    expect(await statut(id)).toBe("SOUMISE");
    expect(litellm.keys.get(tokenId)?.maxBudget).toBe(15);
    await cancelRequest(deps, titulaire, id);

    await testDb.accessRequest.update({ where: { id: cle }, data: { approvedBudget: null, budgetDuration: "30d" } });
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "x" })).rejects.toMatchObject({ code: "transition_interdite" });
  });

  test("un responsable ne décide pas de la hausse de sa propre clé ; un autre responsable de l'équipe, si", async () => {
    await designerResponsable("mmaudet");
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    await expect(approveBudgetRequest(deps, titulaire, id, { budget: 40 })).rejects.toMatchObject({ code: "quatre_yeux" });
    const file = await listPendingRequests(deps, titulaire);
    expect([...file.aTraiter, ...file.aSuivre].map((r) => r.id)).not.toContain(id);

    await designerResponsable("pmartin");
    mailer.outbox.splice(0);
    await approveBudgetRequest(deps, collegue, id, { budget: 40 });
    expect(await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "APPROUVEE", decidedBy: "pmartin" });
    expect(litellm.keys.get(tokenId)?.maxBudget).toBe(40);
    // La décision d'un responsable est annoncée aux admins ; le demandeur, responsable lui aussi, a déjà son courriel.
    expect(mailer.outbox.map((c) => c.to)).toEqual([["mmaudet@linagora.com"], ["admins@linagora.com"]]);
    expect(mailer.outbox[1].text).toContain("Paul Martin (pmartin) a relevé le budget d'une clé de mmaudet.");
  });

  test("un admin ne décide pas de la hausse de sa propre clé ; un autre admin, si", async () => {
    const autreAdmin = { uid: "lbernard", email: "lbernard@linagora.com", name: "Louise Bernard", isAdmin: true };
    litellm.teams.get("equipe-rd")!.memberUids.push("jdupont");
    const { id: cleAdmin } = await createKeyRequest(deps, admin, demande);
    await approveKeyRequest(deps, autreAdmin, cleAdmin, approbation);
    await pickUpKey(deps, admin, cleAdmin);
    const { id } = await createBudgetRequest(deps, admin, { keyRequestId: cleAdmin, requestedBudget: 50, justification: "Lot de contrats" });

    await expect(approveBudgetRequest(deps, admin, id, { budget: 40 })).rejects.toMatchObject({ code: "quatre_yeux" });
    await expect(refuseRequest(deps, admin, id, "Non")).rejects.toMatchObject({ code: "quatre_yeux" });
    await expect(requestCompletion(deps, admin, id, "Précisez")).rejects.toMatchObject({ code: "quatre_yeux" });
    expect(await statut(id)).toBe("SOUMISE");
    const file = await listPendingRequests(deps, admin);
    expect(file.aTraiter.map((r) => r.id)).not.toContain(id);
    expect(file.aSuivre.map((r) => r.id)).toContain(id);
    expect((await listPendingRequests(deps, autreAdmin)).aTraiter.map((r) => r.id)).toContain(id);

    await approveBudgetRequest(deps, autreAdmin, id, { budget: 40 });
    expect(await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "APPROUVEE", decidedBy: "lbernard" });
    expect(await plafondDeLaCle(cleAdmin)).toBe(40);
  });

  test("au dépôt, la hausse part aux admins et aux responsables de l'équipe, hors le demandeur, comme une demande de clé", async () => {
    await designerResponsable("mmaudet");
    await designerResponsable("pmartin");
    await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    expect(mailer.outbox.map((c) => c.to)).toEqual([["admins@linagora.com", "pmartin@linagora.com"]]);
  });

  test("passerelle injoignable : la hausse reste soumise et rien ne change", async () => {
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    mailer.outbox.splice(0);
    litellm.panne = true;
    await expect(approveBudgetRequest(deps, admin, id, { budget: 40 })).rejects.toMatchObject({ code: "passerelle_indisponible" });
    litellm.panne = false;
    expect(await statut(id)).toBe("SOUMISE");
    expect(await plafondDeLaCle(cle)).toBe(15);
    expect(litellm.keys.get(tokenId)?.maxBudget).toBe(15);
    expect((await listAudit(testDb)).map((e) => e.action)).not.toContain("BUDGET_RAISED");
    expect(mailer.outbox).toEqual([]);
  });

  test("deux approbations simultanées : une seule passe, et la passerelle garde le plafond qu'elle a accordé", async () => {
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    const resultats = await Promise.allSettled([approveBudgetRequest(deps, admin, id, { budget: 40 }), approveBudgetRequest(deps, admin, id, { budget: 45 })]);
    expect(resultats.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(resultats.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "transition_interdite" } });
    const accorde = (await testDb.accessRequest.findUniqueOrThrow({ where: { id } })).approvedBudget?.toNumber();
    expect(litellm.keys.get(tokenId)?.maxBudget).toBe(accorde);
    expect(await plafondDeLaCle(cle)).toBe(accorde);
  });

  test("clé remplacée pendant l'approbation : la hausse reste soumise et la nouvelle clé garde l'ancien plafond", async () => {
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    const relever = litellm.updateKeyBudget.bind(litellm);
    // Le titulaire remplace sa clé juste après que la passerelle a relevé le plafond de l'ancienne.
    litellm.updateKeyBudget = async (token, budget) => {
      litellm.updateKeyBudget = relever;
      await relever(token, budget);
      await replaceKey(deps, titulaire, cle);
    };
    await expect(approveBudgetRequest(deps, admin, id, { budget: 40 })).rejects.toMatchObject({ code: "transition_interdite", params: { cas: "modifiee" } });
    expect(await statut(id)).toBe("SOUMISE");
    expect(await plafondDeLaCle(cle)).toBe(15);
    const nouvelle = (await testDb.accessRequest.findUniqueOrThrow({ where: { id: cle } })).keyTokenId as string;
    expect(nouvelle).not.toBe(tokenId);
    expect(litellm.keys.get(nouvelle)?.maxBudget).toBe(15);
    expect((await listAudit(testDb)).map((e) => e.action)).not.toContain("BUDGET_RAISED");
  });

  test("hausse approuvée pendant un remplacement : la nouvelle clé reçoit le plafond accordé", async () => {
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    const generer = litellm.generateKey.bind(litellm);
    // Un admin approuve la hausse juste après que la passerelle a créé la clé de remplacement, à l'ancien plafond.
    litellm.generateKey = async (params) => {
      litellm.generateKey = generer;
      const generee = await generer(params);
      await approveBudgetRequest(deps, admin, id, { budget: 40 });
      return generee;
    };
    await replaceKey(deps, titulaire, cle);
    const nouvelle = (await testDb.accessRequest.findUniqueOrThrow({ where: { id: cle } })).keyTokenId as string;
    expect(nouvelle).not.toBe(tokenId);
    expect(await statut(id)).toBe("APPROUVEE");
    expect(await plafondDeLaCle(cle)).toBe(40);
    expect(litellm.keys.get(nouvelle)?.maxBudget).toBe(40);
  });

  test("révoquée, expirée ou renouvelée, la clé emporte la hausse en cours", async () => {
    const { id: revoquee } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "x" });
    await revokeKey(deps, titulaire, cle);
    expect(await statut(revoquee)).toBe("ANNULEE");

    const renouvelee = await cleEmise({ project: "Renouvelée" });
    const { id: renouvellement } = await createKeyRequest(deps, titulaire, { ...demande, renewsRequestId: renouvelee.id });
    await approveKeyRequest(deps, admin, renouvellement, approbation);
    // Hausse déposée en même temps que le renouvellement, sans passer par le verrou entre les deux demandes.
    const { id: concurrente } = await testDb.accessRequest.create({
      data: {
        kind: "BUDGET",
        requesterUid: "mmaudet",
        requesterEmail: "mmaudet@linagora.com",
        teamId: "equipe-rd",
        teamAlias: "R&D",
        models: [],
        justification: "x",
        requestedBudget: 50,
        raisesBudgetOfRequestId: renouvelee.id,
      },
    });
    await pickUpKey(deps, titulaire, renouvellement);
    expect(await statut(renouvelee.id)).toBe("REVOQUEE");
    expect(await statut(concurrente)).toBe("ANNULEE");

    const expiree = await cleEmise({ project: "Expirée" });
    const { id: perimee } = await createBudgetRequest(deps, titulaire, { keyRequestId: expiree.id, requestedBudget: 50, justification: "x" });
    maintenant = new Date(maintenant.getTime() + 61 * JOUR);
    await listMyRequests(deps, titulaire);
    expect(await statut(expiree.id)).toBe("EXPIREE");
    expect(await statut(perimee)).toBe("ANNULEE");
  });

  test("hausse et renouvellement de la même clé ne se chevauchent pas", async () => {
    const { id: hausse } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "x" });
    await expect(createKeyRequest(deps, titulaire, { ...demande, renewsRequestId: cle })).rejects.toMatchObject({
      code: "demande_en_cours",
      params: { cas: "hausse_avant_renouvellement" },
    });
    await cancelRequest(deps, titulaire, hausse);

    const { id: renouvellement } = await createKeyRequest(deps, titulaire, { ...demande, renewsRequestId: cle });
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "x" })).rejects.toMatchObject({
      code: "demande_en_cours",
      params: { cas: "renouvellement" },
    });
    await approveKeyRequest(deps, admin, renouvellement, approbation);
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "x" })).rejects.toMatchObject({
      code: "demande_en_cours",
      params: { cas: "renouvellement" },
    });
    await pickUpKey(deps, titulaire, renouvellement);
    await expect(createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "x" })).rejects.toMatchObject({ code: "transition_interdite" });
    await createBudgetRequest(deps, titulaire, { keyRequestId: renouvellement, requestedBudget: 50, justification: "x" });
  });

  test("refus, complément et annulation suivent le circuit des demandes", async () => {
    const { id: refusee } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    mailer.outbox.splice(0);
    await expect(refuseRequest(deps, admin, refusee, " ")).rejects.toMatchObject({ code: "motif_obligatoire" });
    await refuseRequest(deps, admin, refusee, "Budget d'équipe épuisé");
    expect(await statut(refusee)).toBe("REFUSEE");
    expect(mailer.outbox.map((c) => c.to)).toEqual([["mmaudet@linagora.com"]]);
    expect(mailer.outbox[0].text).toContain("Votre demande de hausse du budget d'une clé pour l'équipe R&D est refusée.");
    expect(mailer.outbox[0].text).toContain("Your budget increase request for a key of the R&D team is refused.");
    expect(mailer.outbox[0].text).toContain("Motif du refus : Budget d'équipe épuisé");
    expect(litellm.keys.get(tokenId)?.maxBudget).toBe(15);

    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    mailer.outbox.splice(0);
    await requestCompletion(deps, admin, id, "Précisez le volume");
    expect(await statut(id)).toBe("A_COMPLETER");
    expect(mailer.outbox[0].text).toContain("Un administrateur demande un complément sur votre demande de hausse du budget d'une clé pour l'équipe R&D.");
    expect(mailer.outbox[0].text).toContain("An administrator asks for more information about your budget increase request for a key of the R&D team.");

    await expect(completeBudgetRequest(deps, collegue, id, { requestedBudget: 60, justification: "Deux lots" })).rejects.toMatchObject({ code: "introuvable" });
    await expect(completeBudgetRequest(deps, titulaire, cle, { requestedBudget: 60, justification: "Deux lots" })).rejects.toMatchObject({ code: "introuvable" });
    await expect(completeBudgetRequest(deps, titulaire, id, { requestedBudget: 10, justification: "Deux lots" })).rejects.toMatchObject({ code: "budget_trop_bas" });
    await expect(completeBudgetRequest(deps, titulaire, id, { requestedBudget: 60, justification: "" })).rejects.toBeInstanceOf(ZodError);
    await completeBudgetRequest(deps, titulaire, id, { requestedBudget: 60, justification: "Deux lots" });
    const completee = await testDb.accessRequest.findUniqueOrThrow({ where: { id } });
    expect(completee).toMatchObject({ status: "SOUMISE", justification: "Deux lots" });
    expect(completee.requestedBudget?.toNumber()).toBe(60);
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ actorUid: "mmaudet", action: "REQUEST_COMPLETED", targetId: id, details: { kind: "BUDGET", teamAlias: "R&D" } });
    await expect(completeBudgetRequest(deps, titulaire, id, { requestedBudget: 70, justification: "Trois lots" })).rejects.toMatchObject({ code: "transition_interdite" });

    await cancelRequest(deps, titulaire, id);
    expect(await statut(id)).toBe("ANNULEE");
  });

  test("la fiche de validation montre la clé, son plafond, sa dépense, et le budget de l'équipe", async () => {
    Object.assign(litellm.teams.get("equipe-rd")!, { maxBudget: 500, budgetDuration: "30d" });
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    const fiche = await getRequestReview(deps, admin, id);
    expect(fiche).toMatchObject({ kind: "BUDGET", requestedBudget: 50, justification: "Lot de contrats", checks: [] });
    expect(fiche.budgetRaise).toEqual({
      keyAlias: alias,
      currentBudget: 15,
      budgetDuration: "30d",
      spend: 7.5,
      budgetResetAt: litellm.keys.get(tokenId)?.budgetResetAt,
      keyActive: true,
      team: { maxBudget: 500, budgetDuration: "30d" },
    });
    expect((await getRequestReview(deps, admin, cle)).budgetRaise).toBeNull();

    Object.assign(litellm.teams.get("equipe-rd")!, { maxBudget: null, budgetDuration: null });
    litellm.panne = true;
    expect((await getRequestReview(deps, admin, id)).budgetRaise).toEqual({
      keyAlias: alias,
      currentBudget: 15,
      budgetDuration: "30d",
      spend: null,
      budgetResetAt: null,
      keyActive: true,
      team: null,
    });
    litellm.panne = false;

    await revokeKey(deps, admin, cle);
    expect((await getRequestReview(deps, admin, id)).budgetRaise).toMatchObject({ keyAlias: alias, keyActive: false, spend: null });
  });

  test("l'API des intégrations ne voit pas les demandes de hausse", async () => {
    const { id } = await createBudgetRequest(deps, titulaire, { keyRequestId: cle, requestedBudget: 50, justification: "Lot de contrats" });
    const t = ((texte: string) => texte) as unknown as Traducteur;
    const vues = vueDemandes(await listMyRequests(deps, titulaire), t).requests.map((d) => d.id);
    expect(vues).toEqual([cle]);
    expect((await listMyRequests(deps, titulaire)).map((d) => d.id)).toContain(id);
    await expect(cancelRequest(deps, titulaire, id, ["CLE", "ADHESION_EQUIPE"])).rejects.toMatchObject({ code: "introuvable" });
    expect(await statut(id)).toBe("SOUMISE");
  });
});
