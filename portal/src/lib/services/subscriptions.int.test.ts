import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { listAudit } from "./audit";
import { runDailyTask } from "./echeances";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import {
  agreeSubscriptionRequest,
  approveSubscriptionRequest,
  countAdminPending,
  getRequestReview,
  listPendingRequests,
  listProcessedRequests,
  refuseRequest,
  requestCompletion,
} from "./admin-requests";
import { type OfferInput, saveOffer } from "./offers";
import { cancelRequest, listMyRequests } from "./requests";
import { requestOfferChange, requestRenewal } from "./renouvellements";
import { declareTermination, reattachSubscription, requestTermination } from "./resiliations";
import { saveSettings } from "./settings";
import { deleteTeam, designateManager, getTeamPage, removeManager, removeTeamMember } from "./teams";
import {
  completeSubscriptionRequest,
  correctSubscriptionAmount,
  createSubscriptionRequest,
  declareSubscription,
  listActiveSubscriptions,
  listMySubscriptions,
  listSubscriptionArchive,
  listSubscriptionsToDeclare,
  subscriptionRequestDraft,
  type SubscriptionRequestInput,
} from "./subscriptions";

/*
 * Abonnements individuels (spécification #51). Deux équipes : R&D, dont Léa Bernard est responsable et Paul Martin
 * membre, et Data, sans responsable. Jeanne Dupont est admin.
 */
const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const responsable = { uid: "lbernard", email: "lbernard@linagora.com", name: "Léa Bernard", isAdmin: false };
const membre = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };
const ADMINS = ["admins@linagora.com"];
const maintenant = new Date("2026-10-01T09:00:00Z");
/** Annonce d'une décision sur la demande de Paul Martin aux responsables de R&D (F-54). */
const TRAITEE = "[AI GATEWAY] Demande traitée dans l'équipe R&D : pmartin / Request processed in the team R&D: pmartin";

let litellm: FakeLiteLLM;
let mailer: FakeMailer;
let deps: { db: typeof testDb; litellm: FakeLiteLLM; mailer: FakeMailer; adminEmails: string[]; portalUrl: string; now: () => Date };
let offre: string;

const claudeMax: OfferInput = {
  supplier: "Anthropic",
  name: "Claude Max 5x",
  monthlyPriceEur: 108,
  dataLevel: "N1",
  rulesFr: "Désactivez l'entraînement sur vos données.",
  rulesEn: "Turn off training on your data.",
  url: "https://claude.com/pricing",
  visible: true,
};

beforeEach(async () => {
  await resetDb();
  litellm = new FakeLiteLLM()
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: [], memberUids: ["lbernard", "pmartin"] })
    .withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: ["jdupont"] });
  for (const p of [admin, responsable, membre]) litellm.users.set(p.uid, { email: p.email });
  mailer = new FakeMailer();
  deps = { db: testDb, litellm, mailer, adminEmails: ADMINS, portalUrl: "https://portail.test", now: () => maintenant };
  await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "lbernard", email: "lbernard@linagora.com", designatedBy: "jdupont" } });
  offre = await saveOffer(deps, admin, claudeMax);
  await saveSettings(deps, admin, { pickup_days: "14" });
});

const demande = (champs: Partial<SubscriptionRequestInput> = {}): SubscriptionRequestInput => ({
  offerId: offre,
  teamId: "equipe-rd",
  justification: "Rédaction de rapports de veille",
  project: "Veille technologique",
  requestedDays: 90,
  commitment: true,
  ...champs,
});

describe("demander un abonnement et le faire valider (ticket #54)", () => {
  test("un membre demande une offre pour l'une de ses équipes : elle apparaît dans « Mes demandes » et dans la file, et part à la responsable de l'équipe", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    expect(await listMyRequests(deps, membre)).toEqual([
      expect.objectContaining({ id, kind: "ABONNEMENT", teamAlias: "R&D", status: "SOUMISE", offer: "Anthropic · Claude Max 5x" }),
    ]);
    expect((await listPendingRequests(deps, responsable)).aTraiter).toEqual([
      expect.objectContaining({ id, kind: "ABONNEMENT", requesterUid: "pmartin", offer: "Anthropic · Claude Max 5x" }),
    ]);
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["lbernard@linagora.com"], "[AI GATEWAY] Nouvelle demande d'abonnement de Paul Martin / New subscription request from Paul Martin"],
    ]);
    const texte = mailer.outbox[0].text;
    expect(texte).toContain("Paul Martin (pmartin@linagora.com) demande un abonnement :");
    expect(texte).toMatch(/- Équipe : R&D\n- Offre : Anthropic · Claude Max 5x\n- Prix mensuel : 108,00\s€ TTC\n- Niveau maximal : N1 Public\n- Projet : Veille technologique\n- Motif : Rédaction de rapports de veille\n- Durée souhaitée : 3 mois/);
    expect(texte).toContain(`https://portail.test/gestion/demandes/${id}`);
  });

  test("sans engagement, pour une équipe dont il n'est pas membre, pour une offre masquée ou pour une durée hors de la liste, la demande est refusée", async () => {
    await expect(createSubscriptionRequest(deps, membre, demande({ commitment: false }))).rejects.toMatchObject({ code: "engagement_requis" });
    await expect(createSubscriptionRequest(deps, membre, demande({ teamId: "equipe-data" }))).rejects.toMatchObject({ code: "non_membre", params: { equipe: "Data" } });
    await expect(createSubscriptionRequest(deps, membre, demande({ requestedDays: 7 }))).rejects.toMatchObject({ name: "ZodError" });
    await saveOffer(deps, admin, { ...claudeMax, id: offre, visible: false });
    await expect(createSubscriptionRequest(deps, membre, demande())).rejects.toMatchObject({ code: "introuvable", params: { objet: "offre" } });
    expect(await listMyRequests(deps, membre)).toEqual([]);
    expect(mailer.outbox).toEqual([]);
  });

  test("après l'accord du responsable, un admin approuve avec une durée de validité : le demandeur apprend comment souscrire puis déclarer, la responsable est prévenue", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await agreeSubscriptionRequest(deps, responsable, id);
    mailer.outbox.length = 0;
    await approveSubscriptionRequest(deps, admin, id, { days: 180 });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "APPROUVEE" })]);
    expect(await getRequestReview(deps, admin, id)).toMatchObject({
      status: "APPROUVEE",
      decidedBy: "jdupont",
      approvedDays: 180,
      agreement: { by: "lbernard", at: maintenant, comment: null },
      subscriptionOffer: { supplier: "Anthropic", name: "Claude Max 5x", monthlyPriceEur: 108, dataLevel: "N1" },
    });
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["pmartin@linagora.com"], "[AI GATEWAY] Votre demande d'abonnement est approuvée / Your subscription request is approved"],
      [["lbernard@linagora.com"], "[AI GATEWAY] Demande traitée dans l'équipe R&D : pmartin / Request processed in the team R&D: pmartin"],
    ]);
    const [approbation, annonce] = mailer.outbox.map((m) => m.text);
    expect(approbation).toMatch(/Votre demande d'abonnement pour l'équipe R&D est approuvée :\n- Offre : Anthropic · Claude Max 5x\n- Prix mensuel : 108,00\s€ TTC\n- Niveau maximal : N1 Public\n- Durée de validité : 6 mois/);
    expect(approbation).toContain("Souscrivez-le vous-même chez Anthropic, de préférence avec votre adresse professionnelle, et désactivez l'utilisation de vos données pour l'entraînement des modèles.");
    expect(approbation).toContain("Règles d'usage : Désactivez l'entraînement sur vos données.");
    expect(approbation).toContain("Déclarez ensuite l'abonnement dans « Mes abonnements » avant le 15 octobre 2026.");
    expect(approbation).toContain("Usage rules: Turn off training on your data.");
    expect(approbation).toContain("https://portail.test/abonnements");
    expect(annonce).toContain("Jeanne Dupont (jdupont) a approuvé la demande d'abonnement de pmartin.");
  });

  test("un responsable refuse une demande ou demande un complément ; le demandeur complète la sienne, qui repasse en attente, puis l'annule", async () => {
    const refusee = await createSubscriptionRequest(deps, membre, demande());
    const aCompleter = await createSubscriptionRequest(deps, membre, demande({ justification: "Essai" }));
    mailer.outbox.length = 0;
    await refuseRequest(deps, responsable, refusee.id, "Offre trop coûteuse pour ce besoin");
    await requestCompletion(deps, responsable, aCompleter.id, "Précisez le projet");
    const refus = mailer.outbox.find((m) => m.subject === "[AI GATEWAY] Votre demande est refusée / Your request is refused")?.text ?? "";
    expect(refus).toContain("Votre demande d'abonnement pour l'équipe R&D est refusée.");
    expect(refus).toContain("Motif du refus : Offre trop coûteuse pour ce besoin");
    expect(refus).toMatch(/- Offre : Anthropic · Claude Max 5x/);
    const complement = mailer.outbox.find((m) => m.subject === "[AI GATEWAY] Votre demande est à compléter / Your request needs more information")?.text ?? "";
    // C'est la responsable qui le demande, et le courriel le dit.
    expect(complement).toContain("Un responsable de l'équipe demande un complément sur votre demande d'abonnement pour l'équipe R&D.");
    expect(complement).toContain("Commentaire du responsable : Précisez le projet");
    expect(complement).toContain("A manager of the team asks for more information about your subscription request for the R&D team.");
    await completeSubscriptionRequest(deps, membre, aCompleter.id, demande({ justification: "Rapports de veille pour le projet Twake", project: "Twake" }));
    expect(await getRequestReview(deps, responsable, aCompleter.id)).toMatchObject({ status: "SOUMISE", justification: "Rapports de veille pour le projet Twake", project: "Twake" });
    await cancelRequest(deps, membre, aCompleter.id);
    expect((await listMyRequests(deps, membre)).map((r) => [r.id, r.status]).sort()).toEqual(
      [
        [refusee.id, "REFUSEE"],
        [aCompleter.id, "ANNULEE"],
      ].sort(),
    );
  });

  test("un responsable ne donne son accord ni à sa propre demande ni à celle d'une autre équipe, et une seule fois ; une durée hors de la liste est refusée ; une décision ne se prend qu'une fois", async () => {
    const sienne = await createSubscriptionRequest(deps, responsable, demande());
    const autre = await createSubscriptionRequest(deps, admin, demande({ teamId: "equipe-data" }));
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await expect(agreeSubscriptionRequest(deps, responsable, sienne.id)).rejects.toMatchObject({ code: "quatre_yeux" });
    await expect(agreeSubscriptionRequest(deps, responsable, autre.id)).rejects.toMatchObject({ code: "introuvable" });
    await agreeSubscriptionRequest(deps, responsable, id);
    await expect(agreeSubscriptionRequest(deps, responsable, id)).rejects.toMatchObject({ code: "transition_interdite" });
    await expect(approveSubscriptionRequest(deps, admin, sienne.id, { days: 7 })).rejects.toMatchObject({ name: "ZodError" });
    await approveSubscriptionRequest(deps, admin, sienne.id, { days: 365 });
    await expect(approveSubscriptionRequest(deps, admin, sienne.id, { days: 365 })).rejects.toMatchObject({ code: "transition_interdite" });
  });

  test("les demandes, les accords et les décisions d'abonnement sont inscrits au journal d'audit", async () => {
    const id = await approuvee();
    expect((await listAudit(testDb)).filter((e) => e.targetId === id).map((e) => [e.actorUid, e.action, e.details])).toEqual([
      ["pmartin", "REQUEST_CREATED", { kind: "ABONNEMENT", teamAlias: "R&D", offre: "Anthropic · Claude Max 5x" }],
      ["lbernard", "REQUEST_AGREED", { kind: "ABONNEMENT", offre: "Anthropic · Claude Max 5x" }],
      ["jdupont", "REQUEST_APPROVED", { kind: "ABONNEMENT", offre: "Anthropic · Claude Max 5x", jours: 90, accordDe: "lbernard" }],
    ]);
  });

  test("une demande d'abonnement approuvée mais pas encore déclarée est en cours : elle empêche la suppression de l'équipe, et la sortie du membre l'annule", async () => {
    const id = await approuvee();
    await expect(deleteTeam(deps, admin, "equipe-rd")).rejects.toMatchObject({ code: "equipe_non_vide", params: { demandes: "1" } });
    await removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "ANNULEE" })]);
  });
});

describe("où attend une demande d'abonnement : responsables ou admins (ticket #96)", () => {
  test("dans une équipe qui a une responsable, la demande attend son accord : à traiter chez elle et sur sa pastille ; chez l'admin, à part, en attente de l'accord d'un responsable, hors de sa pastille", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    expect(await listPendingRequests(deps, responsable)).toEqual({ aTraiter: [expect.objectContaining({ id })], aSuivre: [] });
    expect(await countAdminPending(deps, responsable)).toBe(1);
    expect(await listPendingRequests(deps, admin)).toEqual({ aTraiter: [], aSuivre: [expect.objectContaining({ id })] });
    expect(await countAdminPending(deps, admin)).toBe(0);
  });

  test("après son accord, la responsable voit la demande à part, en lecture seule, en attente de l'approbation d'un admin : elle ne compte plus sur sa pastille", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await agreeSubscriptionRequest(deps, responsable, id);
    expect(await listPendingRequests(deps, responsable)).toEqual({ aTraiter: [], aSuivre: [expect.objectContaining({ id, status: "ACCORD_RESPONSABLE" })] });
    expect(await countAdminPending(deps, responsable)).toBe(0);
    expect(await listPendingRequests(deps, admin)).toEqual({ aTraiter: [expect.objectContaining({ id })], aSuivre: [] });
  });

  test("dans une équipe sans responsable, la demande attend directement l'approbation d'un admin : elle part aux admins, à approuver chez eux et sur leur pastille", async () => {
    await litellm.addTeamMember("equipe-data", "pmartin");
    const { id } = await createSubscriptionRequest(deps, membre, demande({ teamId: "equipe-data" }));
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [ADMINS, "[AI GATEWAY] Nouvelle demande d'abonnement de Paul Martin / New subscription request from Paul Martin"],
    ]);
    expect(await listPendingRequests(deps, admin)).toEqual({ aTraiter: [expect.objectContaining({ id })], aSuivre: [] });
    expect(await countAdminPending(deps, admin)).toBe(1);
  });

  test("la demande d'une responsable seule dans son équipe va directement aux admins ; un second responsable désigné, elle attend son accord, et son retrait la rend aux admins", async () => {
    const { id } = await createSubscriptionRequest(deps, responsable, demande());
    expect(mailer.outbox.map((m) => m.to)).toEqual([ADMINS]);
    // Sa propre demande ne l'attend jamais : elle n'est pas dans sa file.
    expect(await listPendingRequests(deps, responsable)).toEqual({ aTraiter: [], aSuivre: [] });
    expect(await listPendingRequests(deps, admin)).toEqual({ aTraiter: [expect.objectContaining({ id })], aSuivre: [] });

    // L'étape se déduit des responsables de l'équipe, sans reprise : Paul Martin, désigné, doit donner son accord.
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    expect(await listPendingRequests(deps, membre)).toEqual({ aTraiter: [expect.objectContaining({ id })], aSuivre: [] });
    expect(await listPendingRequests(deps, admin)).toEqual({ aTraiter: [], aSuivre: [expect.objectContaining({ id })] });
    mailer.outbox.length = 0;
    await createSubscriptionRequest(deps, responsable, demande({ justification: "Seconde offre" }));
    expect(mailer.outbox.map((m) => m.to)).toEqual([["pmartin@linagora.com"]]);

    await removeManager(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    expect((await listPendingRequests(deps, admin)).aSuivre).toEqual([]);
  });

  test("un admin responsable d'une équipe en reçoit les demandes d'abonnement, qui l'attendent : il les approuve en un seul temps", async () => {
    await designateManager(deps, admin, { teamId: "equipe-data", uid: "jdupont" });
    await litellm.addTeamMember("equipe-data", "pmartin");
    mailer.outbox.length = 0;
    const { id } = await createSubscriptionRequest(deps, membre, demande({ teamId: "equipe-data" }));
    expect(mailer.outbox.map((m) => m.to)).toEqual([["jdupont@linagora.com"]]);
    expect(await listPendingRequests(deps, admin)).toEqual({ aTraiter: [expect.objectContaining({ id })], aSuivre: [] });
    expect(await countAdminPending(deps, admin)).toBe(1);
    await approveSubscriptionRequest(deps, admin, id, { days: 90 });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "APPROUVEE" })]);
  });
});

describe("approuver ou refuser un abonnement sans attendre l'accord (ticket #97)", () => {

  test("l'admin approuve une demande qui attend encore l'accord de la responsable : la fiche l'en avertit, le journal et l'annonce à la responsable le disent", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    expect(await getRequestReview(deps, admin, id)).toMatchObject({ sansAccord: true });
    mailer.outbox.length = 0;
    await approveSubscriptionRequest(deps, admin, id, { days: 90 });
    expect((await listAudit(testDb)).at(-1)).toMatchObject({
      action: "REQUEST_APPROVED",
      details: { kind: "ABONNEMENT", offre: "Anthropic · Claude Max 5x", jours: 90, sansAccord: true },
    });
    const annonce = mailer.outbox.find((m) => m.subject === TRAITEE);
    expect(annonce?.to).toEqual(["lbernard@linagora.com"]);
    expect(annonce?.text).toContain("Jeanne Dupont (jdupont) a approuvé la demande d'abonnement de pmartin, sans attendre l'accord d'un responsable de l'équipe.");
    expect(annonce?.text).toContain("Jeanne Dupont (jdupont) approved the subscription request of pmartin, without waiting for a team manager's agreement.");
  });

  test("l'admin refuse une demande qui attend encore l'accord de la responsable : le journal et l'annonce à la responsable le disent", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    mailer.outbox.length = 0;
    await refuseRequest(deps, admin, id, "Hors budget");
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ action: "REQUEST_REFUSED", details: { motif: "Hors budget", sansAccord: true } });
    const annonce = mailer.outbox.find((m) => m.subject === TRAITEE);
    expect(annonce?.to).toEqual(["lbernard@linagora.com"]);
    expect(annonce?.text).toContain("Jeanne Dupont (jdupont) a refusé la demande de pmartin, sans attendre l'accord d'un responsable de l'équipe.");
  });

  test("après l'accord, dans une équipe sans responsable, ou responsable lui-même de l'équipe, l'admin ne décide pas sans accord", async () => {
    const avecAccord = await createSubscriptionRequest(deps, membre, demande());
    await agreeSubscriptionRequest(deps, responsable, avecAccord.id);
    expect((await getRequestReview(deps, admin, avecAccord.id)).sansAccord).toBe(false);
    await litellm.addTeamMember("equipe-data", "pmartin");
    const data = await createSubscriptionRequest(deps, membre, demande({ teamId: "equipe-data" }));
    expect((await getRequestReview(deps, admin, data.id)).sansAccord).toBe(false);
    await designateManager(deps, admin, { teamId: "equipe-data", uid: "jdupont" });
    expect((await getRequestReview(deps, admin, data.id)).sansAccord).toBe(false);
    await approveSubscriptionRequest(deps, admin, data.id, { days: 90 });
    // Responsable de Data, l'admin a approuvé en un seul temps : le journal le nomme comme auteur de l'accord.
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ action: "REQUEST_APPROVED", details: { jours: 90, accordDe: "jdupont" } });
    expect((await listAudit(testDb)).at(-1)?.details).not.toHaveProperty("sansAccord");
  });

  test("admin et co-responsable de l'équipe, il approuve en un seul temps ; l'annonce à l'autre responsable ne dit pas qu'il a décidé sans accord", async () => {
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "jdupont" });
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    expect((await getRequestReview(deps, admin, id)).sansAccord).toBe(false);
    mailer.outbox.length = 0;
    await approveSubscriptionRequest(deps, admin, id, { days: 90 });
    expect((await listAudit(testDb)).at(-1)).toMatchObject({ action: "REQUEST_APPROVED", details: { accordDe: "jdupont" } });
    const annonce = mailer.outbox.find((m) => m.subject === TRAITEE);
    expect(annonce?.to).toEqual(["lbernard@linagora.com"]);
    expect(annonce?.text).toContain("Jeanne Dupont (jdupont) a approuvé la demande d'abonnement de pmartin.");
  });

  test("la demande d'une responsable qui a un collègue attend son accord : l'admin qui ne l'attend pas le dit au seul collègue", async () => {
    await designateManager(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    const { id } = await createSubscriptionRequest(deps, responsable, demande());
    expect((await getRequestReview(deps, admin, id)).sansAccord).toBe(true);
    mailer.outbox.length = 0;
    await approveSubscriptionRequest(deps, admin, id, { days: 90 });
    const annonce = mailer.outbox.find((m) => m.subject.startsWith("[AI GATEWAY] Demande traitée dans l'équipe R&D : lbernard"));
    expect(annonce?.to).toEqual(["pmartin@linagora.com"]);
    expect(annonce?.text).toContain("a approuvé la demande d'abonnement de lbernard, sans attendre l'accord d'un responsable de l'équipe.");
  });
});

describe("refus, complément et annulation d'une demande d'abonnement en deux temps (ticket #98)", () => {

  test("la responsable refuse, avec un motif, une demande soumise de son équipe : elle est refusée définitivement, et le demandeur et les admins en sont prévenus", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    mailer.outbox.length = 0;
    await refuseRequest(deps, responsable, id, "Offre trop coûteuse pour ce besoin");
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["pmartin@linagora.com"], "[AI GATEWAY] Votre demande est refusée / Your request is refused"],
      [ADMINS, TRAITEE],
    ]);
    expect(mailer.outbox[1].text).toContain("Léa Bernard (lbernard) a refusé la demande de pmartin.");
    await expect(approveSubscriptionRequest(deps, admin, id, { days: 90 })).rejects.toMatchObject({ code: "transition_interdite" });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "REFUSEE" })]);
  });

  test("l'admin refuse une demande avant ou après l'accord ; la responsable de l'équipe en est prévenue", async () => {
    const avant = await createSubscriptionRequest(deps, membre, demande());
    const apres = await createSubscriptionRequest(deps, membre, demande({ justification: "Second essai" }));
    await agreeSubscriptionRequest(deps, responsable, apres.id);
    mailer.outbox.length = 0;
    await refuseRequest(deps, admin, avant.id, "Hors budget");
    await refuseRequest(deps, admin, apres.id, "Hors budget");
    expect((await listMyRequests(deps, membre)).map((r) => r.status)).toEqual(["REFUSEE", "REFUSEE"]);
    expect(mailer.outbox.filter((m) => m.subject === TRAITEE).map((m) => m.to)).toEqual([["lbernard@linagora.com"], ["lbernard@linagora.com"]]);
  });

  test("après son accord, la responsable n'agit plus sur la demande : ni refus, ni complément, ni second accord", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await agreeSubscriptionRequest(deps, responsable, id);
    await expect(refuseRequest(deps, responsable, id, "Finalement non")).rejects.toMatchObject({ code: "interdit" });
    await expect(requestCompletion(deps, responsable, id, "Précisez le projet")).rejects.toMatchObject({ code: "interdit" });
    await expect(agreeSubscriptionRequest(deps, responsable, id)).rejects.toMatchObject({ code: "transition_interdite" });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "ACCORD_RESPONSABLE" })]);
  });

  test("renvoyée pour complément par la responsable avant son accord, la demande complétée redevient soumise et l'attend de nouveau", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await requestCompletion(deps, responsable, id, "Précisez le projet");
    await completeSubscriptionRequest(deps, membre, id, demande({ project: "Twake" }));
    expect(await listPendingRequests(deps, responsable)).toEqual({ aTraiter: [expect.objectContaining({ id, status: "SOUMISE", project: "Twake" })], aSuivre: [] });
  });

  test("renvoyée pour complément par l'admin après l'accord, la demande complétée revient à « Accord du responsable », sans qu'on le redemande", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await agreeSubscriptionRequest(deps, responsable, id, "Indispensable pour la veille de l'équipe");
    await requestCompletion(deps, admin, id, "Précisez le projet");
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "A_COMPLETER" })]);
    await completeSubscriptionRequest(deps, membre, id, demande({ project: "Twake" }));
    expect(await getRequestReview(deps, admin, id)).toMatchObject({
      status: "ACCORD_RESPONSABLE",
      project: "Twake",
      agreement: { by: "lbernard", comment: "Indispensable pour la veille de l'équipe" },
    });
    expect((await listPendingRequests(deps, admin)).aTraiter).toEqual([expect.objectContaining({ id })]);
    await approveSubscriptionRequest(deps, admin, id, { days: 90 });
  });

  test("renvoyée pour complément par l'admin avant l'accord, la demande complétée redevient soumise et attend la responsable", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    mailer.outbox.length = 0;
    await requestCompletion(deps, admin, id, "Précisez le projet");
    const complement = mailer.outbox.find((m) => m.to[0] === "pmartin@linagora.com")?.text ?? "";
    expect(complement).toContain("Un administrateur demande un complément sur votre demande d'abonnement pour l'équipe R&D.");
    expect(complement).toContain("Commentaire de l'administrateur : Précisez le projet");
    await completeSubscriptionRequest(deps, membre, id, demande({ project: "Twake" }));
    expect((await listPendingRequests(deps, responsable)).aTraiter).toEqual([expect.objectContaining({ id, status: "SOUMISE" })]);
  });

  test("complétée pour une autre équipe, la demande perd l'accord donné par la responsable de la première : elle redevient soumise", async () => {
    await litellm.addTeamMember("equipe-data", "pmartin");
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await agreeSubscriptionRequest(deps, responsable, id);
    await requestCompletion(deps, admin, id, "Précisez le projet");
    await completeSubscriptionRequest(deps, membre, id, demande({ teamId: "equipe-data" }));
    expect(await getRequestReview(deps, admin, id)).toMatchObject({ status: "SOUMISE", teamAlias: "Data", agreement: null });
    // Data n'a pas de responsable : elle attend directement l'approbation d'un admin.
    expect((await listPendingRequests(deps, admin)).aTraiter).toEqual([expect.objectContaining({ id })]);
  });
});

/** Accord de la responsable de R&D, puis approbation par l'admin pour la durée donnée (spécification #93). */
async function accordPuisApprobation(id: string, jours = 90): Promise<void> {
  await agreeSubscriptionRequest(deps, responsable, id);
  await approveSubscriptionRequest(deps, admin, id, { days: jours });
}

/** Demande d'abonnement déposée par le membre, qui reçoit l'accord de la responsable de R&D, puis l'approbation de l'admin pour la durée donnée. */
async function approuvee(champs: Partial<SubscriptionRequestInput> = {}, jours = 90): Promise<string> {
  const { id } = await createSubscriptionRequest(deps, membre, demande(champs));
  await accordPuisApprobation(id, jours);
  return id;
}

describe("accord du responsable puis approbation par un admin (ticket #95)", () => {
  test("un responsable donne son accord à une demande de son équipe, avec un commentaire : elle passe à « Accord du responsable », et l'accord est inscrit sur la demande et au journal d'audit", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await agreeSubscriptionRequest(deps, responsable, id, "Indispensable pour la veille de l'équipe");
    expect(await getRequestReview(deps, admin, id)).toMatchObject({
      status: "ACCORD_RESPONSABLE",
      agreement: { by: "lbernard", at: maintenant, comment: "Indispensable pour la veille de l'équipe" },
    });
    expect((await listAudit(testDb)).at(-1)).toMatchObject({
      actorUid: "lbernard",
      action: "REQUEST_AGREED",
      targetId: id,
      details: { kind: "ABONNEMENT", offre: "Anthropic · Claude Max 5x", commentaire: "Indispensable pour la veille de l'équipe" },
    });
  });

  test("l'accord prévient les admins par le courriel bilingue « demande d'abonnement à approuver », avec le commentaire et le lien vers la fiche ; le demandeur ne reçoit rien", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    mailer.outbox.length = 0;
    await agreeSubscriptionRequest(deps, responsable, id, "Indispensable pour la veille de l'équipe");
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [ADMINS, "[AI GATEWAY] Demande d'abonnement à approuver : Paul Martin / Subscription request to approve: Paul Martin"],
    ]);
    const texte = mailer.outbox[0].text;
    expect(texte).toMatch(
      /Léa Bernard \(lbernard\) a donné son accord à la demande d'abonnement de Paul Martin \(pmartin@linagora\.com\) :\n- Équipe : R&D\n- Offre : Anthropic · Claude Max 5x\n- Prix mensuel : 108,00\s€ TTC/,
    );
    expect(texte).toContain("Commentaire du responsable : Indispensable pour la veille de l'équipe");
    expect(texte).toContain("Léa Bernard (lbernard) agreed to the subscription request from Paul Martin (pmartin@linagora.com):");
    expect(texte).toContain("Manager's comment: Indispensable pour la veille de l'équipe");
    expect(texte).toContain(`https://portail.test/gestion/demandes/${id}`);
  });

  test("seul un responsable de l'équipe donne son accord, jamais sur sa propre demande, fût-il admin : un admin qui n'en est pas responsable l'approuve directement", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await expect(agreeSubscriptionRequest(deps, admin, id)).rejects.toMatchObject({ code: "accord_reserve" });
    await designateManager(deps, admin, { teamId: "equipe-data", uid: "jdupont" });
    const sienne = await createSubscriptionRequest(deps, admin, demande({ teamId: "equipe-data" }));
    await expect(agreeSubscriptionRequest(deps, admin, sienne.id)).rejects.toMatchObject({ code: "quatre_yeux" });
    expect(await listPendingRequests(deps, admin)).toEqual({
      aTraiter: [expect.objectContaining({ id: sienne.id, status: "SOUMISE" })],
      aSuivre: [expect.objectContaining({ id, status: "SOUMISE" })],
    });
  });

  test("un responsable ne peut plus approuver une demande d'abonnement, ni avant ni après son accord : seul un admin l'approuve", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await expect(approveSubscriptionRequest(deps, responsable, id, { days: 90 })).rejects.toMatchObject({ code: "interdit" });
    await agreeSubscriptionRequest(deps, responsable, id);
    await expect(approveSubscriptionRequest(deps, responsable, id, { days: 90 })).rejects.toMatchObject({ code: "interdit" });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "ACCORD_RESPONSABLE" })]);
  });

  test("l'admin retrouve dans la file de validation la demande qui a reçu l'accord de la responsable, et sa pastille la compte ; la responsable ne la compte plus, et elle n'est pas dans l'archive", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await agreeSubscriptionRequest(deps, responsable, id, "Indispensable pour la veille de l'équipe");
    expect((await listPendingRequests(deps, admin)).aTraiter).toEqual([expect.objectContaining({ id, status: "ACCORD_RESPONSABLE", offer: "Anthropic · Claude Max 5x" })]);
    expect(await countAdminPending(deps, admin)).toBe(1);
    expect(await countAdminPending(deps, responsable)).toBe(0);
    expect((await listProcessedRequests(deps, admin)).total).toBe(0);
  });

  test("après l'accord de la responsable, la demande reste en cours : elle empêche la suppression de l'équipe, et la sortie du membre l'annule", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await agreeSubscriptionRequest(deps, responsable, id);
    await expect(deleteTeam(deps, admin, "equipe-rd")).rejects.toMatchObject({ code: "equipe_non_vide", params: { demandes: "1" } });
    await removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "ANNULEE" })]);
  });

  test("après l'accord de la responsable, le demandeur peut encore annuler sa demande, que l'admin ne peut plus approuver", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await agreeSubscriptionRequest(deps, responsable, id);
    await cancelRequest(deps, membre, id);
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "ANNULEE" })]);
    await expect(approveSubscriptionRequest(deps, admin, id, { days: 90 })).rejects.toMatchObject({ code: "transition_interdite" });
  });
});

describe("déclarer un abonnement et le suivre dans « Mes abonnements » (ticket #55)", () => {
  test("le titulaire déclare un abonnement approuvé : il apparaît dans « Mes abonnements », avec son montant, son adresse et son échéance", async () => {
    const id = await approuvee();
    expect(await listMySubscriptions(deps, membre)).toEqual({
      aDeclarer: [
        { requestId: id, offer: "Anthropic · Claude Max 5x", teamAlias: "R&D", approvedDays: 90, declarationDeadline: new Date("2026-10-15T09:00:00Z"), suggestedAmountEur: 108 },
      ],
      abonnements: [],
    });
    deps.now = () => new Date("2026-10-03T10:00:00Z");
    await declareSubscription(deps, membre, id, { subscribedAt: "2026-10-02", monthlyAmountEur: 108, accountEmail: "pmartin@linagora.com" });
    expect(await listMySubscriptions(deps, membre)).toEqual({
      aDeclarer: [],
      abonnements: [
        {
          id: expect.any(String),
          offer: "Anthropic · Claude Max 5x",
          supplier: "Anthropic",
          teamAlias: "R&D",
          accountEmail: "pmartin@linagora.com",
          accountOutsideLinagora: false,
          subscribedAt: new Date("2026-10-02T00:00:00Z"),
          monthlyAmountEur: 108,
          expiresAt: new Date("2026-12-31T00:00:00Z"),
          status: "ACTIF",
          termination: null,
          terminatedOn: null,
          canRenew: false,
          canChangeOffer: true,
          pendingRequest: null,
        },
      ],
    });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "DECLAREE" })]);
  });

  test("une date de souscription passée régularise un abonnement déjà payé : son échéance court alors depuis l'approbation ; une date future est refusée", async () => {
    const id = await approuvee({}, 180);
    await expect(declareSubscription(deps, membre, id, { subscribedAt: "2026-10-05", monthlyAmountEur: 100, accountEmail: "pmartin@linagora.com" })).rejects.toMatchObject({ code: "date_future" });
    await declareSubscription(deps, membre, id, { subscribedAt: "2025-03-15", monthlyAmountEur: 100, accountEmail: "pmartin@linagora.com" });
    expect((await listMySubscriptions(deps, membre)).abonnements).toEqual([
      expect.objectContaining({ subscribedAt: new Date("2025-03-15T00:00:00Z"), monthlyAmountEur: 100, expiresAt: new Date("2027-03-30T00:00:00Z") }),
    ]);
  });

  test("une adresse de compte hors de LINAGORA est acceptée et signalée ; un alias de LINAGORA ne l'est pas", async () => {
    await declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-10-01", monthlyAmountEur: 108, accountEmail: "paul.martin@gmail.com" });
    await declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-10-01", monthlyAmountEur: 108, accountEmail: "pmartin+2@linagora.com" });
    expect((await listMySubscriptions(deps, membre)).abonnements.map((a) => [a.accountEmail, a.accountOutsideLinagora]).sort()).toEqual([
      ["paul.martin@gmail.com", true],
      ["pmartin+2@linagora.com", false],
    ]);
  });

  test("seul le titulaire déclare, une seule fois, une demande approuvée", async () => {
    const id = await approuvee();
    const declaration = { subscribedAt: "2026-10-01", monthlyAmountEur: 108, accountEmail: "pmartin@linagora.com" };
    await expect(declareSubscription(deps, responsable, id, declaration)).rejects.toMatchObject({ code: "introuvable" });
    const soumise = await createSubscriptionRequest(deps, membre, demande());
    await expect(declareSubscription(deps, membre, soumise.id, declaration)).rejects.toMatchObject({ code: "transition_interdite" });
    await declareSubscription(deps, membre, id, declaration);
    await expect(declareSubscription(deps, membre, id, declaration)).rejects.toMatchObject({ code: "transition_interdite" });
    expect((await listMySubscriptions(deps, membre)).abonnements).toHaveLength(1);
  });

  test("deux abonnements de la même offre coexistent, sur deux comptes du même salarié", async () => {
    await declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-10-01", monthlyAmountEur: 108, accountEmail: "pmartin@linagora.com" });
    await declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-10-01", monthlyAmountEur: 108, accountEmail: "pmartin+2@linagora.com" });
    expect((await listMySubscriptions(deps, membre)).abonnements.map((a) => [a.offer, a.status])).toEqual([
      ["Anthropic · Claude Max 5x", "ACTIF"],
      ["Anthropic · Claude Max 5x", "ACTIF"],
    ]);
  });

  test("la déclaration est inscrite au journal d'audit, sans l'adresse du compte", async () => {
    const abonnement = await declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-10-01", monthlyAmountEur: 108, accountEmail: "paul.martin@gmail.com" });
    expect((await listAudit(testDb)).filter((e) => e.targetId === abonnement).map((e) => [e.actorUid, e.action, e.details])).toEqual([
      ["pmartin", "SUBSCRIPTION_DECLARED", { offre: "Anthropic · Claude Max 5x", montant: 108, compteHorsLinagora: true }],
    ]);
  });

  test("la fiche d'une demande d'abonnement montre au responsable les abonnements en cours du demandeur", async () => {
    await declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-09-20", monthlyAmountEur: 108, accountEmail: "pmartin@linagora.com" });
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    expect((await getRequestReview(deps, responsable, id)).requesterSubscriptions).toEqual([
      { offer: "Anthropic · Claude Max 5x", teamAlias: "R&D", subscribedAt: new Date("2026-09-20T00:00:00Z"), monthlyAmountEur: 108 },
    ]);
  });

  test("un rappel part trois jours avant l'échéance de déclaration, une seule fois ; sans déclaration, la demande approuvée expire", async () => {
    const id = await approuvee();
    mailer.outbox.length = 0;
    const tache = (date: string) => runDailyTask({ ...deps, now: () => new Date(date) });
    expect(await tache("2026-10-11T05:00:00Z")).toMatchObject({ rappelsDeclaration: 0 });
    expect(await tache("2026-10-12T05:00:00Z")).toMatchObject({ rappelsDeclaration: 1 });
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["pmartin@linagora.com"], "[AI GATEWAY] Rappel : votre abonnement est à déclarer / Reminder: your subscription is to be declared"],
    ]);
    expect(mailer.outbox[0].text).toContain(
      "Votre demande d'abonnement Anthropic · Claude Max 5x pour l'équipe R&D est approuvée : déclarez l'abonnement dans « Mes abonnements » avant le 15 octobre 2026, faute de quoi elle expirera.",
    );
    expect(mailer.outbox[0].text).toContain("https://portail.test/abonnements");
    expect(await tache("2026-10-13T05:00:00Z")).toMatchObject({ rappelsDeclaration: 0 });
    expect(await tache("2026-10-16T05:00:00Z")).toMatchObject({ demandesExpirees: 1 });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "EXPIREE" })]);
  });

  test("passé le délai de retrait, une déclaration est refusée même si rien n'a encore constaté l'expiration de la demande", async () => {
    const id = await approuvee();
    deps.now = () => new Date("2026-10-16T09:00:00Z");
    await expect(declareSubscription(deps, membre, id, { subscribedAt: "2026-10-10", monthlyAmountEur: 108, accountEmail: "pmartin@linagora.com" })).rejects.toMatchObject({
      code: "transition_interdite",
      params: { cas: "declaration_expiree" },
    });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "EXPIREE" })]);
    expect((await listMySubscriptions(deps, membre)).abonnements).toEqual([]);
  });
});

describe("onglet « Abonnements » de la gestion et résumé sur la page d'une équipe (ticket #56)", () => {
  /** Un abonnement de Paul Martin dans R&D, déclaré à l'adresse donnée, et une demande de Jeanne Dupont dans Data, approuvée mais pas déclarée. */
  async function situation(adresse = "pmartin@linagora.com") {
    const rd = await declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-09-20", monthlyAmountEur: 108, accountEmail: adresse });
    const { id: data } = await createSubscriptionRequest(deps, admin, demande({ teamId: "equipe-data" }));
    await approveSubscriptionRequest(deps, admin, data, { days: 30 });
    return { rd, data };
  }

  test("la gestion liste les abonnements à déclarer, les actifs et l'archive ; un responsable n'y voit que ses équipes", async () => {
    const { rd, data } = await situation("paul.martin@gmail.com");
    expect(await listSubscriptionsToDeclare(deps, admin)).toEqual([
      {
        requestId: data,
        holderUid: "jdupont",
        holderEmail: "jdupont@linagora.com",
        teamAlias: "Data",
        offer: "Anthropic · Claude Max 5x",
        approvedAt: maintenant,
        declarationDeadline: new Date("2026-10-15T09:00:00Z"),
      },
    ]);
    expect(await listActiveSubscriptions(deps, admin)).toEqual([
      {
        id: rd,
        holderUid: "pmartin",
        holderEmail: "pmartin@linagora.com",
        teamAlias: "R&D",
        offer: "Anthropic · Claude Max 5x",
        accountEmail: "paul.martin@gmail.com",
        accountOutsideLinagora: true,
        subscribedAt: new Date("2026-09-20T00:00:00Z"),
        monthlyAmountEur: 108,
        expiresAt: new Date("2026-12-30T00:00:00Z"),
        status: "ACTIF",
        termination: null,
        terminatedOn: null,
        charges: [{ chargedOn: new Date("2026-09-20T00:00:00Z"), amountEur: 108, teamAlias: "R&D" }],
      },
    ]);
    expect(await listSubscriptionArchive(deps, admin)).toEqual({ elements: [], page: 1, pages: 1, total: 0 });
    expect(await listSubscriptionsToDeclare(deps, responsable)).toEqual([]);
    expect((await listActiveSubscriptions(deps, responsable)).map((a) => a.id)).toEqual([rd]);
  });

  test("le filtre d'équipe limite les listes ; une équipe hors de l'autorité d'un responsable n'y retient rien ; un salarié n'y accède pas", async () => {
    const { rd, data } = await situation();
    expect((await listSubscriptionsToDeclare(deps, admin, { equipe: "equipe-data" })).map((d) => d.requestId)).toEqual([data]);
    expect(await listActiveSubscriptions(deps, admin, { equipe: "equipe-data" })).toEqual([]);
    expect((await listActiveSubscriptions(deps, admin, { equipe: "equipe-rd" })).map((a) => a.id)).toEqual([rd]);
    expect(await listSubscriptionsToDeclare(deps, responsable, { equipe: "equipe-data" })).toEqual([]);
    await expect(listActiveSubscriptions(deps, membre)).rejects.toMatchObject({ code: "interdit" });
  });

  test("la page d'une équipe donne le nombre et le coût mensuel de ses abonnements actifs", async () => {
    await situation();
    await declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-09-25", monthlyAmountEur: 23.5, accountEmail: "pmartin+2@linagora.com" });
    expect((await getTeamPage(deps, responsable, "equipe-rd")).subscriptions).toEqual({ count: 2, monthlyTotalEur: 131.5 });
    expect((await getTeamPage(deps, admin, "equipe-data")).subscriptions).toEqual({ count: 0, monthlyTotalEur: 0 });
  });
});

describe("prélèvements aux dates anniversaires et correction du montant (ticket #57)", () => {
  /** Abonnement de Paul Martin dans R&D, approuvé le 1er octobre 2026 puis déclaré à la date donnée. */
  async function declare(souscription: string, montant = 108): Promise<string> {
    return declareSubscription(deps, membre, await approuvee(), { subscribedAt: souscription, monthlyAmountEur: montant, accountEmail: "pmartin@linagora.com" });
  }
  const prelevements = async () => (await listActiveSubscriptions(deps, admin))[0].charges.map((c) => [c.chargedOn.toISOString().slice(0, 10), c.amountEur, c.teamAlias]);

  test("une déclaration passée compte d'un coup les prélèvements déjà échus : à la souscription, puis chaque mois au même jour, ramené à la fin des mois courts", async () => {
    await declare("2026-07-31");
    expect(await prelevements()).toEqual([
      ["2026-07-31", 108, "R&D"],
      ["2026-08-31", 108, "R&D"],
      ["2026-09-30", 108, "R&D"],
    ]);
  });

  test("une souscription du 31 janvier est prélevée le dernier jour de février, le 28 ou le 29 selon l'année", async () => {
    await declare("2026-01-31");
    await runDailyTask({ ...deps, now: () => new Date("2028-03-01T05:00:00Z") });
    const dates = (await prelevements()).map(([date]) => date);
    expect(dates.slice(0, 4)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
    expect(dates.filter((date) => String(date).slice(5, 7) === "02")).toEqual(["2026-02-28", "2027-02-28", "2028-02-29"]);
  });

  test("la tâche quotidienne compte les prélèvements échus, rattrapage compris, une seule fois chacun ; son compte rendu les compte", async () => {
    await declare("2026-10-01");
    const tache = (date: string) => runDailyTask({ ...deps, now: () => new Date(date) });
    expect(await tache("2026-10-15T05:00:00Z")).toMatchObject({ prelevements: 0 });
    expect(await tache("2027-01-05T05:00:00Z")).toMatchObject({ prelevements: 3 });
    expect(await tache("2027-01-06T05:00:00Z")).toMatchObject({ prelevements: 0 });
    expect((await prelevements()).map(([date]) => date)).toEqual(["2026-10-01", "2026-11-01", "2026-12-01", "2027-01-01"]);
  });

  test("le titulaire corrige le montant de son abonnement : la correction vaut à partir du prélèvement suivant, et elle est inscrite au journal", async () => {
    const abonnement = await declare("2026-10-01");
    await correctSubscriptionAmount(deps, membre, abonnement, { monthlyAmountEur: 120 });
    await runDailyTask({ ...deps, now: () => new Date("2026-11-02T05:00:00Z") });
    expect(await prelevements()).toEqual([
      ["2026-10-01", 108, "R&D"],
      ["2026-11-01", 120, "R&D"],
    ]);
    expect((await listMySubscriptions(deps, membre)).abonnements[0].monthlyAmountEur).toBe(120);
    expect((await listAudit(testDb)).filter((e) => e.action === "SUBSCRIPTION_AMOUNT_CORRECTED").map((e) => [e.actorUid, e.targetId, e.details])).toEqual([
      ["pmartin", abonnement, { ancien: 108, nouveau: 120 }],
    ]);
  });

  test("seul le titulaire corrige le montant de son abonnement, qui doit rester positif", async () => {
    const abonnement = await declare("2026-10-01");
    await expect(correctSubscriptionAmount(deps, responsable, abonnement, { monthlyAmountEur: 50 })).rejects.toMatchObject({ code: "introuvable" });
    await expect(correctSubscriptionAmount(deps, membre, abonnement, { monthlyAmountEur: 0 })).rejects.toMatchObject({ name: "ZodError" });
    expect((await listMySubscriptions(deps, membre)).abonnements[0].monthlyAmountEur).toBe(108);
  });
});

describe("résiliation, demandes de résiliation et rattachement (ticket #58)", () => {
  /** Abonnement de Paul Martin dans R&D, souscrit le 31 juillet 2026 : prélevé les 31 juillet, 31 août et 30 septembre. */
  async function abonnement(): Promise<string> {
    return declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-07-31", monthlyAmountEur: 108, accountEmail: "pmartin@linagora.com" });
  }
  const jours = (charges: { chargedOn: Date }[]) => charges.map((c) => c.chargedOn.toISOString().slice(0, 10));
  const journal = async (action: string) => (await listAudit(testDb)).filter((e) => e.action === action).map((e) => [e.actorUid, e.targetId, e.details]);
  const responsableData = { uid: "cmoreau", email: "cmoreau@linagora.com", name: "Chloé Moreau", isAdmin: false };
  const DEMANDE_DE_RESILIATION =
    "[AI GATEWAY] Demande de résiliation de votre abonnement Anthropic · Claude Max 5x / Cancellation request for your subscription Anthropic · Claude Max 5x";

  test("le titulaire déclare la résiliation : l'abonnement passe dans l'archive avec sa date, sans courriel, et aucun prélèvement ne compte à partir de cette date", async () => {
    const id = await abonnement();
    mailer.outbox.length = 0;
    await declareTermination(deps, membre, id, { terminatedOn: "2026-09-15" });
    expect(mailer.outbox).toEqual([]);
    expect(await listActiveSubscriptions(deps, admin)).toEqual([]);
    const [archive] = (await listSubscriptionArchive(deps, admin)).elements;
    expect(archive).toMatchObject({ id, status: "RESILIE", terminatedOn: new Date("2026-09-15T00:00:00Z") });
    expect(jours(archive.charges)).toEqual(["2026-07-31", "2026-08-31"]);
    expect(await runDailyTask({ ...deps, now: () => new Date("2026-12-01T05:00:00Z") })).toMatchObject({ prelevements: 0 });
    expect((await listMySubscriptions(deps, membre)).abonnements).toEqual([expect.objectContaining({ id, status: "RESILIE", terminatedOn: new Date("2026-09-15T00:00:00Z") })]);
    expect(await journal("SUBSCRIPTION_TERMINATED")).toEqual([["pmartin", id, { offre: "Anthropic · Claude Max 5x", equipe: "R&D", date: "2026-09-15" }]]);
  });

  test("la date de résiliation n'est ni future ni antérieure à la souscription ; seuls le titulaire et un admin la déclarent, une seule fois", async () => {
    const id = await abonnement();
    await expect(declareTermination(deps, membre, id, { terminatedOn: "2026-10-02" })).rejects.toMatchObject({ code: "date_future" });
    await expect(declareTermination(deps, membre, id, { terminatedOn: "2026-07-30" })).rejects.toMatchObject({ code: "date_avant_souscription" });
    await expect(declareTermination(deps, responsable, id, { terminatedOn: "2026-09-15" })).rejects.toMatchObject({ code: "introuvable" });
    // Résilié le jour même de sa souscription, un abonnement n'a aucun prélèvement.
    await declareTermination(deps, membre, id, { terminatedOn: "2026-07-31" });
    expect((await listSubscriptionArchive(deps, admin)).elements).toEqual([expect.objectContaining({ id, charges: [] })]);
    await expect(declareTermination(deps, admin, id, { terminatedOn: "2026-09-15" })).rejects.toMatchObject({ code: "transition_interdite" });
  });

  test("un admin déclare la résiliation à la place du titulaire : elle est inscrite à son nom, et le titulaire en est prévenu s'il est toujours là", async () => {
    const id = await abonnement();
    const autre = await abonnement();
    mailer.outbox.length = 0;
    await declareTermination(deps, admin, id, { terminatedOn: "2026-09-20" });
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["pmartin@linagora.com"], "[AI GATEWAY] Résiliation de votre abonnement Anthropic · Claude Max 5x / Cancellation of your subscription Anthropic · Claude Max 5x"],
    ]);
    expect(mailer.outbox[0].text).toContain(
      "Un administrateur a déclaré la résiliation de votre abonnement Anthropic · Claude Max 5x, rattaché à l'équipe R&D, au 20 septembre 2026 : aucun prélèvement ne lui est plus compté à partir de cette date. Si ce n'est déjà fait, résiliez-le chez Anthropic.",
    );
    // Parti de l'entreprise, le titulaire n'est plus prévenu.
    litellm.users.delete("pmartin");
    mailer.outbox.length = 0;
    await declareTermination(deps, admin, autre, { terminatedOn: "2026-09-20" });
    expect(mailer.outbox).toEqual([]);
    expect((await journal("SUBSCRIPTION_TERMINATED")).map(([acteur, cible]) => [acteur, cible])).toEqual([
      ["jdupont", id],
      ["jdupont", autre],
    ]);
  });

  test("un responsable demande la résiliation, avec un motif : le titulaire est prévenu, les admins l'apprennent comme un changement dans l'équipe, et la demande est au journal", async () => {
    const id = await abonnement();
    mailer.outbox.length = 0;
    await requestTermination(deps, responsable, id, { reason: "Besoin disparu avec la fin du projet" });
    expect(await listActiveSubscriptions(deps, admin)).toEqual([
      expect.objectContaining({
        id,
        status: "A_RESILIER",
        termination: { origin: "RESPONSABLE", requestedBy: "lbernard", requestedAt: maintenant, reason: "Besoin disparu avec la fin du projet" },
      }),
    ]);
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["pmartin@linagora.com"], DEMANDE_DE_RESILIATION],
      [ADMINS, "[AI GATEWAY] Résiliation demandée dans l'équipe R&D : pmartin / Cancellation requested in the team R&D: pmartin"],
    ]);
    const [demande, annonce] = mailer.outbox.map((m) => m.text);
    expect(demande).toContain("Un responsable de votre équipe demande la résiliation de votre abonnement Anthropic · Claude Max 5x, rattaché à l'équipe R&D.");
    expect(demande).toContain("Motif : Besoin disparu avec la fin du projet");
    expect(demande).toContain("Résiliez-le chez Anthropic, puis déclarez la résiliation dans « Mes abonnements » avant le 15 octobre 2026.");
    expect(demande).toContain("https://portail.test/abonnements");
    expect(annonce).toContain("Léa Bernard (lbernard) a demandé la résiliation de l'abonnement Anthropic · Claude Max 5x de pmartin.");
    expect(await journal("SUBSCRIPTION_TERMINATION_REQUESTED")).toEqual([
      ["lbernard", id, { origine: "RESPONSABLE", offre: "Anthropic · Claude Max 5x", equipe: "R&D", motif: "Besoin disparu avec la fin du projet" }],
    ]);
  });

  test("demandée par un admin, la résiliation est annoncée aux seuls responsables de l'équipe", async () => {
    const id = await abonnement();
    mailer.outbox.length = 0;
    await requestTermination(deps, admin, id, { reason: "Coût" });
    expect(mailer.outbox.map((m) => m.to)).toEqual([["pmartin@linagora.com"], ["lbernard@linagora.com"]]);
    expect(mailer.outbox[0].text).toContain("Un administrateur demande la résiliation de votre abonnement Anthropic · Claude Max 5x, rattaché à l'équipe R&D.");
    expect((await listActiveSubscriptions(deps, admin))[0].termination).toMatchObject({ origin: "ADMIN", requestedBy: "jdupont" });
  });

  test("seuls un admin et les responsables de l'équipe de l'abonnement demandent sa résiliation, avec un motif, une seule fois", async () => {
    const id = await abonnement();
    await testDb.teamManager.create({ data: { teamId: "equipe-data", uid: "cmoreau", email: "cmoreau@linagora.com", designatedBy: "jdupont" } });
    await expect(requestTermination(deps, membre, id, { reason: "Coût" })).rejects.toMatchObject({ code: "interdit" });
    await expect(requestTermination(deps, responsableData, id, { reason: "Coût" })).rejects.toMatchObject({ code: "introuvable" });
    await expect(requestTermination(deps, responsable, id, { reason: "  " })).rejects.toMatchObject({ code: "motif_obligatoire" });
    await requestTermination(deps, responsable, id, { reason: "Coût" });
    await expect(requestTermination(deps, admin, id, { reason: "Coût" })).rejects.toMatchObject({ code: "transition_interdite" });
  });

  test("la sortie de l'équipe fait une demande de résiliation ; le rattachement à une autre équipe du titulaire la lève, et les prélèvements suivants vont à la nouvelle équipe", async () => {
    const id = await declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-10-01", monthlyAmountEur: 108, accountEmail: "pmartin@linagora.com" });
    await litellm.addTeamMember("equipe-data", "pmartin");
    mailer.outbox.length = 0;
    await removeTeamMember(deps, responsable, { teamId: "equipe-rd", uid: "pmartin" });
    expect(await listActiveSubscriptions(deps, admin)).toEqual([
      expect.objectContaining({ id, status: "A_RESILIER", teamAlias: "R&D", termination: { origin: "SORTIE", requestedBy: "lbernard", requestedAt: maintenant, reason: null } }),
    ]);
    const demande = mailer.outbox.find((m) => m.subject === DEMANDE_DE_RESILIATION);
    expect(demande?.to).toEqual(["pmartin@linagora.com"]);
    expect(demande?.text).toContain(
      "Après votre sortie de l'équipe R&D, votre abonnement Anthropic · Claude Max 5x, qui lui était rattaché, est à résilier, sauf si un admin ou un responsable d'une autre de vos équipes l'y rattache.",
    );

    // La page de l'équipe d'arrivée propose le rattachement.
    expect((await getTeamPage(deps, admin, "equipe-data")).subscriptionsToReattach).toEqual([
      { id, holderUid: "pmartin", offer: "Anthropic · Claude Max 5x", teamAlias: "R&D", requestedAt: maintenant },
    ]);
    await reattachSubscription(deps, admin, id, { teamId: "equipe-data" });
    expect(await listActiveSubscriptions(deps, admin)).toEqual([expect.objectContaining({ id, status: "ACTIF", teamAlias: "Data", termination: null })]);
    expect((await getTeamPage(deps, admin, "equipe-data")).subscriptionsToReattach).toEqual([]);
    await runDailyTask({ ...deps, now: () => new Date("2026-11-02T05:00:00Z") });
    expect((await listActiveSubscriptions(deps, admin))[0].charges.map((c) => [c.chargedOn.toISOString().slice(0, 10), c.teamAlias])).toEqual([
      ["2026-10-01", "R&D"],
      ["2026-11-01", "Data"],
    ]);
    expect(await journal("SUBSCRIPTION_TERMINATION_REQUESTED")).toEqual([["lbernard", id, { origine: "SORTIE", offre: "Anthropic · Claude Max 5x", equipe: "R&D", motif: null }]]);
    expect(await journal("SUBSCRIPTION_REATTACHED")).toEqual([["jdupont", id, { offre: "Anthropic · Claude Max 5x", de: "R&D", vers: "Data", demandeLevee: true }]]);
  });

  test("seuls un admin et les responsables de l'équipe d'arrivée rattachent un abonnement, à une équipe dont le titulaire est membre", async () => {
    const id = await abonnement();
    await testDb.teamManager.create({ data: { teamId: "equipe-data", uid: "cmoreau", email: "cmoreau@linagora.com", designatedBy: "jdupont" } });
    await expect(reattachSubscription(deps, responsable, id, { teamId: "equipe-data" })).rejects.toMatchObject({ code: "introuvable" });
    await expect(reattachSubscription(deps, responsableData, id, { teamId: "equipe-data" })).rejects.toMatchObject({ code: "non_membre" });
    await litellm.addTeamMember("equipe-data", "pmartin");
    await reattachSubscription(deps, responsableData, id, { teamId: "equipe-data" });
    expect((await listActiveSubscriptions(deps, admin))[0]).toMatchObject({ id, status: "ACTIF", teamAlias: "Data" });
    // Une demande de résiliation d'un responsable n'est pas levée par un rattachement.
    await requestTermination(deps, responsableData, id, { reason: "Coût" });
    await reattachSubscription(deps, admin, id, { teamId: "equipe-rd" });
    expect((await listActiveSubscriptions(deps, admin))[0]).toMatchObject({ status: "A_RESILIER", teamAlias: "R&D", termination: expect.objectContaining({ origin: "RESPONSABLE" }) });
  });

  test("sans résiliation déclarée dans le délai de retrait, une alerte part une seule fois aux responsables de l'équipe et aux admins", async () => {
    const id = await abonnement();
    await requestTermination(deps, responsable, id, { reason: "Coût" });
    mailer.outbox.length = 0;
    const tache = (date: string) => runDailyTask({ ...deps, now: () => new Date(date) });
    expect(await tache("2026-10-14T05:00:00Z")).toMatchObject({ alertesResiliation: 0 });
    expect(await tache("2026-10-16T05:00:00Z")).toMatchObject({ alertesResiliation: 1 });
    expect(await tache("2026-10-17T05:00:00Z")).toMatchObject({ alertesResiliation: 0 });
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [[...ADMINS, "lbernard@linagora.com"], "[AI GATEWAY] Résiliation non déclarée : Anthropic · Claude Max 5x de pmartin / Undeclared cancellation: Anthropic · Claude Max 5x of pmartin"],
    ]);
    expect(mailer.outbox[0].text).toContain(
      "La résiliation de l'abonnement Anthropic · Claude Max 5x de pmartin, rattaché à l'équipe R&D, a été demandée le 1 octobre 2026 ; elle n'est toujours pas déclarée.",
    );
    expect(mailer.outbox[0].text).toContain("https://portail.test/gestion/abonnements?equipe=equipe-rd");
  });

  test("une équipe ne se supprime pas tant qu'un abonnement non résilié lui est rattaché", async () => {
    const id = await abonnement();
    await removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    await removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "lbernard" });
    await expect(deleteTeam(deps, admin, "equipe-rd")).rejects.toMatchObject({ code: "equipe_non_vide", params: { abonnements: "1" } });
    await declareTermination(deps, admin, id, { terminatedOn: "2026-09-30" });
    await deleteTeam(deps, admin, "equipe-rd");
  });
});

describe("échéance, renouvellement et changement d'offre (ticket #59)", () => {
  /** Abonnement de Paul Martin dans R&D, approuvé le 1er octobre 2026 pour la durée donnée, souscrit à la date donnée. */
  async function declare(souscription = "2026-10-01", jours = 90): Promise<string> {
    return declareSubscription(deps, membre, await approuvee({}, jours), { subscribedAt: souscription, monthlyAmountEur: 108, accountEmail: "pmartin@linagora.com" });
  }
  const renouvellement = () => ({ justification: "Usage quotidien pour le projet Twake", project: "Twake", requestedDays: 180, commitment: true });
  const changement = () => ({ justification: "Besoin de plus de capacité", project: null, requestedDays: 90, commitment: true });
  const tache = (date: string) => runDailyTask({ ...deps, now: () => new Date(date) });
  const journal = async (action: string) => (await listAudit(testDb)).filter((e) => e.action === action).map((e) => [e.actorUid, e.targetId, e.details]);
  const DEMANDE_DE_RESILIATION =
    "[AI GATEWAY] Demande de résiliation de votre abonnement Anthropic · Claude Max 5x / Cancellation request for your subscription Anthropic · Claude Max 5x";
  const RAPPEL = "[AI GATEWAY] Échéance de votre abonnement Anthropic · Claude Max 5x / Expiry of your subscription Anthropic · Claude Max 5x";

  test("un changement d'offre et un renouvellement partent, comme toute demande d'abonnement, à la responsable de l'équipe (ticket #96)", async () => {
    const [abonnement, autre] = [await declare(), await declare()];
    const max20 = await saveOffer(deps, admin, { ...claudeMax, name: "Claude Max 20x", monthlyPriceEur: 216 });
    mailer.outbox.length = 0;
    await requestOfferChange(deps, membre, abonnement, { ...changement(), offerId: max20 });
    deps.now = () => new Date("2026-12-01T09:00:00Z");
    await requestRenewal(deps, membre, autre, renouvellement());
    expect(mailer.outbox.map((m) => m.to)).toEqual([["lbernard@linagora.com"], ["lbernard@linagora.com"]]);
  });

  test("la tâche quotidienne rappelle au titulaire l'échéance de son abonnement un mois, sept jours et la veille, chacun une seule fois", async () => {
    await declare();
    mailer.outbox.length = 0;
    const rappels: number[] = [];
    for (const date of ["2026-11-29T06:00:00Z", "2026-11-30T06:00:00Z", "2026-12-01T06:00:00Z", "2026-12-23T06:00:00Z", "2026-12-24T06:00:00Z", "2026-12-29T06:00:00Z", "2026-12-29T18:00:00Z"]) {
      rappels.push((await tache(date)).rappelsEcheance);
    }
    expect(rappels).toEqual([0, 1, 0, 1, 0, 1, 0]);
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual(Array(3).fill([["pmartin@linagora.com"], RAPPEL]));
    const [unMois, , veille] = mailer.outbox.map((m) => m.text);
    expect(unMois).toContain("Votre abonnement Anthropic · Claude Max 5x, rattaché à l'équipe R&D, arrive à échéance le 30 décembre 2026, dans 30 jours.");
    expect(unMois).toContain("Demandez son renouvellement dans « Mes abonnements » ; sinon, résiliez-le chez Anthropic, puis déclarez la résiliation.");
    expect(veille).toContain("arrive à échéance le 30 décembre 2026, demain.");
  });

  test("un abonnement autorisé pour un mois n'a pas de rappel un mois avant son échéance", async () => {
    await declare("2026-10-01", 30);
    expect(await tache("2026-10-01T10:00:00Z")).toMatchObject({ rappelsEcheance: 0 });
    expect(await tache("2026-10-24T06:00:00Z")).toMatchObject({ rappelsEcheance: 1 });
  });

  test("à l'échéance d'un abonnement non renouvelé, la tâche quotidienne fait une demande de résiliation, dont le titulaire est prévenu", async () => {
    const id = await declare();
    mailer.outbox.length = 0;
    expect(await tache("2026-12-29T06:00:00Z")).toMatchObject({ demandesResiliation: 0 });
    expect(await tache("2026-12-30T06:00:00Z")).toMatchObject({ demandesResiliation: 1 });
    expect(await tache("2026-12-31T06:00:00Z")).toMatchObject({ demandesResiliation: 0 });
    expect((await listActiveSubscriptions(deps, admin))[0]).toMatchObject({
      id,
      status: "A_RESILIER",
      termination: { origin: "ECHEANCE", requestedBy: "systeme", requestedAt: new Date("2026-12-30T06:00:00Z"), reason: null },
    });
    const demande = mailer.outbox.find((m) => m.subject === DEMANDE_DE_RESILIATION);
    expect(demande?.to).toEqual(["pmartin@linagora.com"]);
    expect(demande?.text).toContain("Votre abonnement Anthropic · Claude Max 5x, rattaché à l'équipe R&D, est arrivé à échéance sans être renouvelé : il est à résilier.");
    expect(demande?.text).toContain("Résiliez-le chez Anthropic, puis déclarez la résiliation dans « Mes abonnements » avant le 13 janvier 2027.");
    expect(await journal("SUBSCRIPTION_TERMINATION_REQUESTED")).toEqual([["systeme", id, { origine: "ECHEANCE", offre: "Anthropic · Claude Max 5x", equipe: "R&D", motif: null }]]);
  });

  test("dès un mois avant l'échéance, le titulaire demande le renouvellement ; approuvé, il reporte l'échéance de la durée approuvée, sans nouvelle déclaration", async () => {
    const id = await declare();
    deps.now = () => new Date("2026-11-29T09:00:00Z");
    expect((await listMySubscriptions(deps, membre)).abonnements[0]).toMatchObject({ canRenew: false, canChangeOffer: true, pendingRequest: null });
    await expect(requestRenewal(deps, membre, id, renouvellement())).rejects.toMatchObject({ code: "renouvellement_trop_tot" });
    deps.now = () => new Date("2026-11-30T09:00:00Z");
    expect((await listMySubscriptions(deps, membre)).abonnements[0]).toMatchObject({ canRenew: true });
    const { id: demande } = await requestRenewal(deps, membre, id, renouvellement());
    await expect(requestRenewal(deps, membre, id, renouvellement())).rejects.toMatchObject({ code: "demande_en_cours" });
    expect((await listMySubscriptions(deps, membre)).abonnements[0]).toMatchObject({ canRenew: false, canChangeOffer: false, pendingRequest: { id: demande, type: "RENOUVELLEMENT" } });
    expect((await listPendingRequests(deps, responsable)).aTraiter).toEqual([expect.objectContaining({ id: demande, kind: "ABONNEMENT", offer: "Anthropic · Claude Max 5x" })]);
    expect(await getRequestReview(deps, responsable, demande)).toMatchObject({
      requestedDays: 180,
      renewedSubscription: { id, offer: "Anthropic · Claude Max 5x", expiresAt: new Date("2026-12-30T00:00:00Z") },
      replacedSubscription: null,
    });
    expect(await tache("2026-11-30T10:00:00Z")).toMatchObject({ rappelsEcheance: 1 });

    await agreeSubscriptionRequest(deps, responsable, demande);
    // Après l'accord de la responsable, la demande de renouvellement reste en cours jusqu'à la décision de l'admin.
    await expect(requestRenewal(deps, membre, id, renouvellement())).rejects.toMatchObject({ code: "demande_en_cours" });
    expect((await listMySubscriptions(deps, membre)).abonnements[0]).toMatchObject({ canRenew: false, canChangeOffer: false, pendingRequest: { id: demande, type: "RENOUVELLEMENT" } });
    mailer.outbox.length = 0;
    await approveSubscriptionRequest(deps, admin, demande, { days: 180 });
    const [abonnement] = (await listMySubscriptions(deps, membre)).abonnements;
    expect(abonnement).toMatchObject({ id, status: "ACTIF", expiresAt: new Date("2027-06-28T00:00:00Z"), pendingRequest: null });
    expect((await listMySubscriptions(deps, membre)).aDeclarer).toEqual([]);
    expect(await listMyRequests(deps, membre)).toEqual(expect.arrayContaining([expect.objectContaining({ id: demande, status: "RENOUVELEE" })]));
    expect(mailer.outbox[0]).toMatchObject({ to: ["pmartin@linagora.com"], subject: "[AI GATEWAY] Votre demande de renouvellement est approuvée / Your renewal request is approved" });
    expect(mailer.outbox[0].text).toContain("L'échéance de votre abonnement Anthropic · Claude Max 5x, rattaché à l'équipe R&D, est reportée au 28 juin 2027 : rien d'autre à faire.");
    // Les rappels repartent pour la nouvelle échéance.
    expect(await tache("2027-05-29T06:00:00Z")).toMatchObject({ rappelsEcheance: 1 });
  });

  test("refusé, le renouvellement fait une demande de résiliation, dont le titulaire est prévenu avec le motif", async () => {
    const id = await declare();
    deps.now = () => new Date("2026-12-01T09:00:00Z");
    const { id: demande } = await requestRenewal(deps, membre, id, renouvellement());
    mailer.outbox.length = 0;
    await refuseRequest(deps, responsable, demande, "Budget de l'équipe épuisé");
    expect((await listActiveSubscriptions(deps, admin))[0]).toMatchObject({
      id,
      status: "A_RESILIER",
      termination: { origin: "RENOUVELLEMENT_REFUSE", requestedBy: "lbernard", requestedAt: new Date("2026-12-01T09:00:00Z"), reason: "Budget de l'équipe épuisé" },
    });
    expect(mailer.outbox.map((m) => m.subject)).toEqual(expect.arrayContaining(["[AI GATEWAY] Votre demande est refusée / Your request is refused", DEMANDE_DE_RESILIATION]));
    const resiliation = mailer.outbox.find((m) => m.subject === DEMANDE_DE_RESILIATION)?.text;
    expect(resiliation).toContain("Le renouvellement de votre abonnement Anthropic · Claude Max 5x, rattaché à l'équipe R&D, est refusé : il est à résilier.");
    expect(resiliation).toContain("Motif : Budget de l'équipe épuisé");
  });

  test("à l'échéance, un renouvellement en attente suspend la demande de résiliation", async () => {
    const id = await declare();
    deps.now = () => new Date("2026-12-20T09:00:00Z");
    await requestRenewal(deps, membre, id, renouvellement());
    expect(await tache("2026-12-30T06:00:00Z")).toMatchObject({ demandesResiliation: 0 });
    expect((await listActiveSubscriptions(deps, admin))[0]).toMatchObject({ id, status: "ACTIF" });
  });

  test("à l'échéance, un renouvellement qui a reçu l'accord de la responsable suspend aussi la demande de résiliation (ticket #95)", async () => {
    const id = await declare();
    deps.now = () => new Date("2026-12-20T09:00:00Z");
    const { id: demande } = await requestRenewal(deps, membre, id, renouvellement());
    await agreeSubscriptionRequest(deps, responsable, demande);
    expect(await tache("2026-12-30T06:00:00Z")).toMatchObject({ demandesResiliation: 0 });
    expect((await listActiveSubscriptions(deps, admin))[0]).toMatchObject({ id, status: "ACTIF" });
  });

  test("approuvé après l'échéance, le renouvellement lève la demande de résiliation née de l'échéance et reporte l'échéance passée", async () => {
    const id = await declare();
    await tache("2026-12-30T06:00:00Z");
    deps.now = () => new Date("2027-01-02T09:00:00Z");
    const { id: demande } = await requestRenewal(deps, membre, id, { ...renouvellement(), requestedDays: 90 });
    await accordPuisApprobation(demande, 90);
    expect((await listActiveSubscriptions(deps, admin))[0]).toMatchObject({ id, status: "ACTIF", termination: null, expiresAt: new Date("2027-03-30T00:00:00Z") });
  });

  test("changement d'offre : à la déclaration de la nouvelle offre, seul l'abonnement d'origine est résilié, à la date de souscription déclarée", async () => {
    const origine = await declare();
    const jumeau = await declare();
    const max20 = await saveOffer(deps, admin, { ...claudeMax, name: "Claude Max 20x", monthlyPriceEur: 216 });
    const autreFournisseur = await saveOffer(deps, admin, { ...claudeMax, supplier: "OpenAI", name: "ChatGPT Pro 5x", monthlyPriceEur: 103 });
    await expect(requestOfferChange(deps, membre, origine, { ...changement(), offerId: autreFournisseur })).rejects.toMatchObject({ code: "introuvable" });
    await expect(requestOfferChange(deps, membre, origine, { ...changement(), offerId: offre })).rejects.toMatchObject({ code: "introuvable" });
    const { id: demande } = await requestOfferChange(deps, membre, origine, { ...changement(), offerId: max20 });
    expect((await listMySubscriptions(deps, membre)).abonnements.find((a) => a.id === origine)).toMatchObject({ pendingRequest: { id: demande, type: "CHANGEMENT_OFFRE" } });
    expect(await getRequestReview(deps, responsable, demande)).toMatchObject({
      subscriptionOffer: { name: "Claude Max 20x" },
      renewedSubscription: null,
      replacedSubscription: { id: origine, offer: "Anthropic · Claude Max 5x" },
    });
    await agreeSubscriptionRequest(deps, responsable, demande);
    mailer.outbox.length = 0;
    await approveSubscriptionRequest(deps, admin, demande, { days: 90 });
    expect(mailer.outbox[0].text).toContain(
      "Cet abonnement remplace votre abonnement Anthropic · Claude Max 5x : à sa déclaration, l'abonnement remplacé sera résilié à la date de souscription déclarée.",
    );
    deps.now = () => new Date("2026-10-14T09:00:00Z");
    const nouveau = await declareSubscription(deps, membre, demande, { subscribedAt: "2026-10-13", monthlyAmountEur: 216, accountEmail: "pmartin@linagora.com" });
    expect((await listSubscriptionArchive(deps, admin)).elements.map((a) => [a.id, a.terminatedOn])).toEqual([[origine, new Date("2026-10-13T00:00:00Z")]]);
    expect((await listActiveSubscriptions(deps, admin)).map((a) => a.id).sort()).toEqual([jumeau, nouveau].sort());
    expect(await journal("SUBSCRIPTION_OFFER_CHANGED")).toEqual([
      ["pmartin", origine, { offre: "Anthropic · Claude Max 5x", nouvelleOffre: "Anthropic · Claude Max 20x", date: "2026-10-13", nouvelAbonnement: nouveau }],
    ]);
  });

  test("renvoyé pour complément après l'accord de la responsable, un renouvellement y revient une fois complété (ticket #98)", async () => {
    const id = await declare();
    deps.now = () => new Date("2026-12-01T09:00:00Z");
    const { id: demande } = await requestRenewal(deps, membre, id, renouvellement());
    await agreeSubscriptionRequest(deps, responsable, demande);
    await requestCompletion(deps, admin, demande, "Précisez l'usage");
    await completeSubscriptionRequest(deps, membre, demande, { ...renouvellement(), offerId: offre, teamId: "equipe-rd" });
    expect(await getRequestReview(deps, admin, demande)).toMatchObject({ status: "ACCORD_RESPONSABLE", agreement: { by: "lbernard" } });
  });

  test("renvoyé pour complément après l'accord de la responsable, un changement d'offre y revient une fois complété (ticket #98)", async () => {
    const id = await declare();
    const max20 = await saveOffer(deps, admin, { ...claudeMax, name: "Claude Max 20x", monthlyPriceEur: 216 });
    const { id: demande } = await requestOfferChange(deps, membre, id, { ...changement(), offerId: max20 });
    await agreeSubscriptionRequest(deps, responsable, demande);
    await requestCompletion(deps, admin, demande, "Précisez le besoin");
    await completeSubscriptionRequest(deps, membre, demande, { ...changement(), offerId: max20, teamId: "equipe-rd" });
    expect(await getRequestReview(deps, admin, demande)).toMatchObject({ status: "ACCORD_RESPONSABLE", offer: "Anthropic · Claude Max 20x" });
  });

  test("approuvé sans attendre l'accord de la responsable, un renouvellement le dit au journal (ticket #97)", async () => {
    const id = await declare();
    deps.now = () => new Date("2026-12-01T09:00:00Z");
    const { id: demande } = await requestRenewal(deps, membre, id, renouvellement());
    await approveSubscriptionRequest(deps, admin, demande, { days: 180 });
    expect((await journal("REQUEST_APPROVED")).at(-1)).toEqual(["jdupont", demande, expect.objectContaining({ jours: 180, sansAccord: true })]);
  });

  test("renvoyé pour complément, un renouvellement se complète sans changer d'offre ni d'équipe", async () => {
    const id = await declare();
    deps.now = () => new Date("2026-12-01T09:00:00Z");
    const { id: demande } = await requestRenewal(deps, membre, id, renouvellement());
    await requestCompletion(deps, responsable, demande, "Précisez l'usage");
    expect(await subscriptionRequestDraft(deps, membre, demande)).toMatchObject({
      linked: "RENOUVELLEMENT",
      offerId: offre,
      teamId: "equipe-rd",
      requestedDays: 180,
      offer: expect.objectContaining({ name: "Claude Max 5x", rules: "Désactivez l'entraînement sur vos données." }),
    });
    await completeSubscriptionRequest(deps, membre, demande, { offerId: "autre", teamId: "equipe-data", justification: "Rapports quotidiens", project: null, requestedDays: 90, commitment: true });
    expect(await getRequestReview(deps, responsable, demande)).toMatchObject({
      status: "SOUMISE",
      teamAlias: "R&D",
      offer: "Anthropic · Claude Max 5x",
      justification: "Rapports quotidiens",
      requestedDays: 90,
      renewedSubscription: { id },
    });
  });

  test("seul le titulaire demande le renouvellement ou le changement d'offre d'un abonnement non résilié", async () => {
    const id = await declare();
    deps.now = () => new Date("2026-12-01T09:00:00Z");
    await expect(requestRenewal(deps, responsable, id, renouvellement())).rejects.toMatchObject({ code: "introuvable" });
    await declareTermination(deps, membre, id, { terminatedOn: "2026-11-15" });
    await expect(requestRenewal(deps, membre, id, renouvellement())).rejects.toMatchObject({ code: "introuvable" });
    await expect(requestOfferChange(deps, membre, id, { ...changement(), offerId: offre })).rejects.toMatchObject({ code: "introuvable" });
  });
});
