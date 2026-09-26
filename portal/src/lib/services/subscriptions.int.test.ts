import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { listAudit } from "./audit";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { approveSubscriptionRequest, getRequestReview, listPendingRequests, refuseRequest, requestCompletion } from "./admin-requests";
import { type OfferInput, saveOffer } from "./offers";
import { cancelRequest, listMyRequests } from "./requests";
import { saveSettings } from "./settings";
import { deleteTeam, removeTeamMember } from "./teams";
import { completeSubscriptionRequest, createSubscriptionRequest, type SubscriptionRequestInput } from "./subscriptions";

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

