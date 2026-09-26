import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { listAudit } from "./audit";
import { runDailyTask } from "./echeances";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { approveSubscriptionRequest, getRequestReview, listPendingRequests, refuseRequest, requestCompletion } from "./admin-requests";
import { type OfferInput, saveOffer } from "./offers";
import { cancelRequest, listMyRequests } from "./requests";
import { saveSettings } from "./settings";
import { deleteTeam, getTeamPage, removeTeamMember } from "./teams";
import {
  completeSubscriptionRequest,
  createSubscriptionRequest,
  declareSubscription,
  listActiveSubscriptions,
  listMySubscriptions,
  listSubscriptionArchive,
  listSubscriptionsToDeclare,
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
  test("un membre demande une offre pour l'une de ses équipes : elle apparaît dans « Mes demandes » et dans la file, et part aux responsables et aux admins", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    expect(await listMyRequests(deps, membre)).toEqual([
      expect.objectContaining({ id, kind: "ABONNEMENT", teamAlias: "R&D", status: "SOUMISE", offer: "Anthropic · Claude Max 5x" }),
    ]);
    expect(await listPendingRequests(deps, responsable)).toEqual([expect.objectContaining({ id, kind: "ABONNEMENT", requesterUid: "pmartin", offer: "Anthropic · Claude Max 5x" })]);
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [[...ADMINS, "lbernard@linagora.com"], "[AI GATEWAY] Nouvelle demande d'abonnement de Paul Martin / New subscription request from Paul Martin"],
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

  test("un responsable de l'équipe approuve avec une durée de validité : le demandeur apprend comment souscrire puis déclarer, les admins sont prévenus", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    mailer.outbox.length = 0;
    await approveSubscriptionRequest(deps, responsable, id, { days: 180 });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "APPROUVEE" })]);
    expect(await getRequestReview(deps, admin, id)).toMatchObject({
      status: "APPROUVEE",
      decidedBy: "lbernard",
      approvedDays: 180,
      subscriptionOffer: { supplier: "Anthropic", name: "Claude Max 5x", monthlyPriceEur: 108, dataLevel: "N1" },
    });
    expect(mailer.outbox.map((m) => [m.to, m.subject])).toEqual([
      [["pmartin@linagora.com"], "[AI GATEWAY] Votre demande d'abonnement est approuvée / Your subscription request is approved"],
      [ADMINS, "[AI GATEWAY] Demande traitée dans l'équipe R&D : pmartin / Request processed in the team R&D: pmartin"],
    ]);
    const [approbation, annonce] = mailer.outbox.map((m) => m.text);
    expect(approbation).toMatch(/Votre demande d'abonnement pour l'équipe R&D est approuvée :\n- Offre : Anthropic · Claude Max 5x\n- Prix mensuel : 108,00\s€ TTC\n- Niveau maximal : N1 Public\n- Durée de validité : 6 mois/);
    expect(approbation).toContain("Souscrivez-le vous-même chez Anthropic, de préférence avec votre adresse professionnelle, et désactivez l'utilisation de vos données pour l'entraînement des modèles.");
    expect(approbation).toContain("Règles d'usage : Désactivez l'entraînement sur vos données.");
    expect(approbation).toContain("Déclarez ensuite l'abonnement dans « Mes abonnements » avant le 15 octobre 2026.");
    expect(approbation).toContain("Usage rules: Turn off training on your data.");
    expect(approbation).toContain("https://portail.test/abonnements");
    expect(annonce).toContain("Léa Bernard (lbernard) a approuvé la demande d'abonnement de pmartin.");
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
    expect(complement).toContain("Un administrateur demande un complément sur votre demande d'abonnement pour l'équipe R&D.");
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

  test("un responsable ne décide ni de sa propre demande ni d'une autre équipe ; une durée hors de la liste est refusée ; une décision ne se prend qu'une fois", async () => {
    const sienne = await createSubscriptionRequest(deps, responsable, demande());
    const autre = await createSubscriptionRequest(deps, admin, demande({ teamId: "equipe-data" }));
    await expect(approveSubscriptionRequest(deps, responsable, sienne.id, { days: 90 })).rejects.toMatchObject({ code: "quatre_yeux" });
    await expect(approveSubscriptionRequest(deps, responsable, autre.id, { days: 90 })).rejects.toMatchObject({ code: "introuvable" });
    await expect(approveSubscriptionRequest(deps, admin, sienne.id, { days: 7 })).rejects.toMatchObject({ name: "ZodError" });
    await approveSubscriptionRequest(deps, admin, sienne.id, { days: 365 });
    await expect(approveSubscriptionRequest(deps, admin, sienne.id, { days: 365 })).rejects.toMatchObject({ code: "transition_interdite" });
  });

  test("les demandes et les décisions d'abonnement sont inscrites au journal d'audit", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await approveSubscriptionRequest(deps, responsable, id, { days: 90 });
    expect((await listAudit(testDb)).filter((e) => e.targetId === id).map((e) => [e.actorUid, e.action, e.details])).toEqual([
      ["pmartin", "REQUEST_CREATED", { kind: "ABONNEMENT", teamAlias: "R&D", offre: "Anthropic · Claude Max 5x" }],
      ["lbernard", "REQUEST_APPROVED", { kind: "ABONNEMENT", offre: "Anthropic · Claude Max 5x", jours: 90 }],
    ]);
  });

  test("une demande d'abonnement approuvée mais pas encore déclarée est en cours : elle empêche la suppression de l'équipe, et la sortie du membre l'annule", async () => {
    const { id } = await createSubscriptionRequest(deps, membre, demande());
    await approveSubscriptionRequest(deps, responsable, id, { days: 90 });
    await expect(deleteTeam(deps, admin, "equipe-rd")).rejects.toMatchObject({ code: "equipe_non_vide", params: { demandes: "1" } });
    await removeTeamMember(deps, admin, { teamId: "equipe-rd", uid: "pmartin" });
    expect(await listMyRequests(deps, membre)).toEqual([expect.objectContaining({ id, status: "ANNULEE" })]);
  });
});

/** Demande d'abonnement déposée par le membre, puis approuvée par la responsable de R&D pour la durée donnée. */
async function approuvee(champs: Partial<SubscriptionRequestInput> = {}, jours = 90): Promise<string> {
  const { id } = await createSubscriptionRequest(deps, membre, demande(champs));
  await approveSubscriptionRequest(deps, responsable, id, { days: jours });
  return id;
}

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
      },
    ]);
    expect(await listSubscriptionArchive(deps, admin)).toEqual({ elements: [], page: 1, pages: 1, total: 0 });
    expect(await listSubscriptionsToDeclare(deps, responsable)).toEqual([]);
    expect((await listActiveSubscriptions(deps, responsable)).map((a) => a.id)).toEqual([rd]);
  });

  test("le filtre d'équipe limite les listes ; une équipe hors de l'autorité d'un responsable n'y retient rien ; un salarié n'y accède pas", async () => {
    const { rd, data } = await situation();
    expect((await listSubscriptionsToDeclare(deps, admin, "equipe-data")).map((d) => d.requestId)).toEqual([data]);
    expect(await listActiveSubscriptions(deps, admin, "equipe-data")).toEqual([]);
    expect((await listActiveSubscriptions(deps, admin, "equipe-rd")).map((a) => a.id)).toEqual([rd]);
    expect(await listSubscriptionsToDeclare(deps, responsable, "equipe-data")).toEqual([]);
    await expect(listActiveSubscriptions(deps, membre)).rejects.toMatchObject({ code: "interdit" });
  });

  test("la page d'une équipe donne le nombre et le coût mensuel de ses abonnements actifs", async () => {
    await situation();
    await declareSubscription(deps, membre, await approuvee(), { subscribedAt: "2026-09-25", monthlyAmountEur: 23.5, accountEmail: "pmartin+2@linagora.com" });
    expect((await getTeamPage(deps, responsable, "equipe-rd")).subscriptions).toEqual({ count: 2, monthlyTotalEur: 131.5 });
    expect((await getTeamPage(deps, admin, "equipe-data")).subscriptions).toEqual({ count: 0, monthlyTotalEur: 0 });
  });
});
