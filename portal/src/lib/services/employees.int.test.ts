import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { getEmployeePage, listEmployees } from "./employees";

/*
 * Fiche d'un salarié (retours de l'utilisateur du 2026-09-26) : ce qu'il utilise, clés et abonnements, avec ses équipes.
 * Deux équipes : R&D, dont Léa Bernard est responsable, et Data, sans responsable. Paul Martin est membre des deux ;
 * Jeanne Dupont, admin, est membre de Data.
 */
const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const responsable = { uid: "lbernard", email: "lbernard@linagora.com", name: "Léa Bernard", isAdmin: false };
const membre = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };
const EQUIPES = { "equipe-rd": "R&D", "equipe-data": "Data" } as const;
type Equipe = keyof typeof EQUIPES;

let deps: { db: typeof testDb; litellm: FakeLiteLLM; mailer: FakeMailer; adminEmails: string[]; portalUrl: string };
let offerId: string;

beforeEach(async () => {
  await resetDb();
  const litellm = new FakeLiteLLM()
    .withTeam({ teamId: "equipe-rd", teamAlias: "R&D", models: [], memberUids: ["lbernard", "pmartin"] })
    .withTeam({ teamId: "equipe-data", teamAlias: "Data", models: [], memberUids: ["jdupont", "pmartin"] });
  for (const p of [admin, responsable, membre]) litellm.users.set(p.uid, { email: p.email });
  deps = { db: testDb, litellm, mailer: new FakeMailer(), adminEmails: ["admins@linagora.com"], portalUrl: "https://portail.test" };
  await testDb.teamManager.create({ data: { teamId: "equipe-rd", uid: "lbernard", email: "lbernard@linagora.com", designatedBy: "jdupont" } });
  ({ id: offerId } = await testDb.subscriptionOffer.create({
    data: { supplier: "Moonshot AI", name: "Kimi Moderato", monthlyPriceEur: 18, dataLevel: "N1", rulesFr: "Usage professionnel", updatedBy: "jdupont" },
  }));
});

/** Clé enregistrée directement : approuvée (à retirer), émise ou révoquée. Rend l'identifiant de sa demande. */
const cle = async (uid: string, teamId: Equipe, status: "APPROUVEE" | "CLE_EMISE" | "REVOQUEE") =>
  (
    await testDb.accessRequest.create({
      data: {
        kind: "CLE", status, requesterUid: uid, requesterEmail: `${uid}@linagora.com`, teamId, teamAlias: EQUIPES[teamId], dataLevel: "N2",
        models: ["mistral-small"], justification: "Essai", decidedAt: new Date(),
        ...(status === "APPROUVEE" ? {} : { keyAlias: `${uid}-${teamId}-${status}`, keyTokenId: `empreinte-${uid}-${teamId}-${status}`, keyIssuedAt: new Date() }),
      },
    })
  ).id;

/** Abonnement enregistré directement : approuvé (à déclarer : rend la demande), actif ou résilié (rend l'abonnement). */
const abonnement = async (uid: string, teamId: Equipe, etat: "APPROUVEE" | "ACTIF" | "RESILIE") => {
  const demande = await testDb.accessRequest.create({
    data: {
      kind: "ABONNEMENT", status: etat === "APPROUVEE" ? "APPROUVEE" : "DECLAREE", requesterUid: uid, requesterEmail: `${uid}@linagora.com`,
      teamId, teamAlias: EQUIPES[teamId], dataLevel: "N1", models: [], justification: "Essai", offerId, decidedAt: new Date(),
    },
  });
  if (etat === "APPROUVEE") return demande.id;
  const { id } = await testDb.subscription.create({
    data: {
      requestId: demande.id, offerId, holderUid: uid, holderEmail: `${uid}@linagora.com`, teamId, teamAlias: EQUIPES[teamId],
      accountEmail: `${uid}@exemple.org`, subscribedAt: new Date("2026-09-01"), monthlyAmountEur: 18, expiresAt: new Date("2026-12-01"),
      status: etat, ...(etat === "RESILIE" ? { terminatedOn: new Date("2026-09-20") } : {}),
    },
  });
  return id;
};

describe("fiche d'un salarié", () => {
  test("pour un admin, elle réunit ses équipes et son rôle, ses clés à retirer et actives, ses abonnements à déclarer et actifs, sans ce qui est clos ni ce qui est à d'autres", async () => {
    const aRetirer = await cle("pmartin", "equipe-data", "APPROUVEE");
    const active = await cle("pmartin", "equipe-rd", "CLE_EMISE");
    await cle("pmartin", "equipe-rd", "REVOQUEE");
    await cle("lbernard", "equipe-rd", "CLE_EMISE");
    const aDeclarer = await abonnement("pmartin", "equipe-rd", "APPROUVEE");
    const actif = await abonnement("pmartin", "equipe-data", "ACTIF");
    await abonnement("pmartin", "equipe-data", "RESILIE");
    await abonnement("lbernard", "equipe-rd", "ACTIF");

    const fiche = await getEmployeePage(deps, admin, "pmartin");
    expect(fiche).toMatchObject({ uid: "pmartin", email: "pmartin@linagora.com" });
    expect(fiche.teams).toEqual([
      { teamId: "equipe-data", teamAlias: "Data", manager: false },
      { teamId: "equipe-rd", teamAlias: "R&D", manager: false },
    ]);
    expect(fiche.keysToPickUp.map((k) => k.requestId)).toEqual([aRetirer]);
    expect(fiche.activeKeys.map((k) => k.requestId)).toEqual([active]);
    expect(fiche.subscriptionsToDeclare.map((a) => a.requestId)).toEqual([aDeclarer]);
    expect(fiche.activeSubscriptions.map((a) => a.id)).toEqual([actif]);
    // La responsable de R&D y figure comme telle.
    expect((await getEmployeePage(deps, admin, "lbernard")).teams).toEqual([{ teamId: "equipe-rd", teamAlias: "R&D", manager: true }]);
  });

  test("un responsable n'y voit que ce qui relève de ses équipes ; un salarié hors de ses équipes lui est introuvable", async () => {
    await cle("pmartin", "equipe-data", "CLE_EMISE");
    const cleRd = await cle("pmartin", "equipe-rd", "CLE_EMISE");
    await abonnement("pmartin", "equipe-data", "ACTIF");
    const abonnementRd = await abonnement("pmartin", "equipe-rd", "ACTIF");

    const fiche = await getEmployeePage(deps, responsable, "pmartin");
    expect(fiche.teams.map((t) => t.teamAlias)).toEqual(["R&D"]);
    expect(fiche.activeKeys.map((k) => k.requestId)).toEqual([cleRd]);
    expect(fiche.activeSubscriptions.map((a) => a.id)).toEqual([abonnementRd]);
    await expect(getEmployeePage(deps, responsable, "jdupont")).rejects.toMatchObject({ code: "introuvable" });
  });

  test("un uid inconnu est introuvable ; un salarié sans rôle n'accède à aucune fiche", async () => {
    await expect(getEmployeePage(deps, admin, "inconnu")).rejects.toMatchObject({ code: "introuvable" });
    await expect(getEmployeePage(deps, membre, "pmartin")).rejects.toMatchObject({ code: "interdit" });
  });
});

describe("onglet « Salariés »", () => {
  /** Paul Martin : deux clés émises (R&D, Data), une à retirer, un abonnement actif (Data), un résilié (R&D). Un ancien salarié, sans équipe, a une clé révoquée dans Data. */
  const situation = async () => {
    await cle("pmartin", "equipe-rd", "CLE_EMISE");
    await cle("pmartin", "equipe-data", "CLE_EMISE");
    await cle("pmartin", "equipe-data", "APPROUVEE");
    await abonnement("pmartin", "equipe-data", "ACTIF");
    await abonnement("pmartin", "equipe-rd", "RESILIE");
    await cle("ancien", "equipe-data", "REVOQUEE");
  };

  test("un admin voit tous les salariés connus du portail, par uid, avec leurs équipes, leurs clés actives et leurs abonnements actifs", async () => {
    await situation();
    expect(await listEmployees(deps, admin)).toEqual([
      { uid: "ancien", email: "ancien@linagora.com", teams: [], activeKeyCount: 0, activeSubscriptionCount: 0 },
      { uid: "jdupont", email: null, teams: ["Data"], activeKeyCount: 0, activeSubscriptionCount: 0 },
      { uid: "lbernard", email: "lbernard@linagora.com", teams: ["R&D"], activeKeyCount: 0, activeSubscriptionCount: 0 },
      { uid: "pmartin", email: "pmartin@linagora.com", teams: ["Data", "R&D"], activeKeyCount: 2, activeSubscriptionCount: 1 },
    ]);
  });

  test("un responsable ne voit que les salariés de ses équipes, avec ce qu'ils y utilisent", async () => {
    await situation();
    expect(await listEmployees(deps, responsable)).toEqual([
      { uid: "lbernard", email: "lbernard@linagora.com", teams: ["R&D"], activeKeyCount: 0, activeSubscriptionCount: 0 },
      { uid: "pmartin", email: "pmartin@linagora.com", teams: ["R&D"], activeKeyCount: 1, activeSubscriptionCount: 0 },
    ]);
    await expect(listEmployees(deps, membre)).rejects.toMatchObject({ code: "interdit" });
  });

  test("la recherche retient les salariés dont l'uid ou l'adresse contient le texte, sans tenir compte de la casse", async () => {
    await situation();
    expect((await listEmployees(deps, admin, { recherche: " MART " })).map((s) => s.uid)).toEqual(["pmartin"]);
    expect((await listEmployees(deps, admin, { recherche: "ancien@linagora" })).map((s) => s.uid)).toEqual(["ancien"]);
    expect(await listEmployees(deps, admin, { recherche: "personne" })).toEqual([]);
  });

  test("filtrée sur une équipe (depuis le nombre de ses membres), la liste ne retient qu'elle, dans l'autorité de l'acteur", async () => {
    await situation();
    expect(await listEmployees(deps, admin, { equipe: "equipe-rd" })).toEqual([
      { uid: "lbernard", email: "lbernard@linagora.com", teams: ["R&D"], activeKeyCount: 0, activeSubscriptionCount: 0 },
      { uid: "pmartin", email: "pmartin@linagora.com", teams: ["R&D"], activeKeyCount: 1, activeSubscriptionCount: 0 },
    ]);
    expect(await listEmployees(deps, responsable, { equipe: "equipe-data" })).toEqual([]);
  });
});
