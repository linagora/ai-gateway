import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { listAudit } from "./audit";
import { listChargesToReimburse, listTransmissions, transmissionCsv, transmitCharges } from "./remboursements";

/*
 * Remboursements (retours de l'utilisateur du 2026-09-26) : les prélèvements des abonnements, à rembourser aux
 * collaborateurs sur la base de leurs déclarations, transmis à la comptabilité une seule fois.
 */
const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const collaborateur = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };
const deps = { db: testDb, now: () => new Date("2026-10-02T09:00:00Z") };

beforeEach(async () => {
  await resetDb();
});

/** Abonnement déclaré par un titulaire, avec ses prélèvements aux jours donnés (AAAA-MM-JJ) ; rend leurs identifiants. */
async function abonnement(titulaire: { uid: string; name: string | null }, offre: string, montant: number, jours: string[]): Promise<string[]> {
  const offer = await testDb.subscriptionOffer.create({
    data: { supplier: "Anthropic", name: offre, monthlyPriceEur: montant, dataLevel: "N1", rulesFr: "Usage professionnel", updatedBy: "jdupont" },
  });
  const demande = await testDb.accessRequest.create({
    data: {
      kind: "ABONNEMENT", status: "DECLAREE", requesterUid: titulaire.uid, requesterEmail: `${titulaire.uid}@linagora.com`, teamId: "equipe-rd",
      teamAlias: "R&D", dataLevel: "N1", models: [], justification: "Essai", offerId: offer.id,
    },
  });
  const { id } = await testDb.subscription.create({
    data: {
      requestId: demande.id, offerId: offer.id, holderUid: titulaire.uid, holderEmail: `${titulaire.uid}@linagora.com`, holderName: titulaire.name,
      teamId: "equipe-rd", teamAlias: "R&D", accountEmail: `${titulaire.uid}@linagora.com`, subscribedAt: new Date(`${jours[0]}T00:00:00Z`),
      monthlyAmountEur: montant, expiresAt: new Date("2027-09-01T00:00:00Z"),
    },
  });
  const ids: string[] = [];
  for (const jour of jours) {
    const charge = await testDb.subscriptionCharge.create({
      data: { subscriptionId: id, chargedOn: new Date(`${jour}T00:00:00Z`), amountEur: montant, teamId: "equipe-rd", teamAlias: "R&D" },
    });
    ids.push(charge.id);
  }
  return ids;
}

/** Paul Martin : Claude Pro prélevé les 20 août, 20 septembre et 20 octobre ; Léa Bernard : ChatGPT Plus le 5 septembre ; zeta, sans nom : Kimi le 30 septembre. */
const situation = async () => ({
  paul: await abonnement({ uid: "pmartin", name: "Paul Martin" }, "Claude Pro", 21.6, ["2026-08-20", "2026-09-20", "2026-10-20"]),
  lea: await abonnement({ uid: "lbernard", name: "Léa Bernard" }, "ChatGPT Plus", 22.99, ["2026-09-05"]),
  zeta: await abonnement({ uid: "zeta", name: null }, "Kimi", 18, ["2026-09-30"]),
});

const jour = (j: string) => new Date(`${j}T00:00:00Z`);

describe("remboursements", () => {
  test("la liste d'un mois réunit, par collaborateur, les prélèvements non transmis jusqu'à la fin du mois, retards compris", async () => {
    const { paul, lea, zeta } = await situation();
    expect(await listChargesToReimburse(deps, admin, "2026-09")).toEqual({
      month: "2026-09",
      count: 4,
      totalEur: 84.19,
      employees: [
        {
          uid: "lbernard", name: "Léa Bernard", email: "lbernard@linagora.com", totalEur: 22.99,
          charges: [{ id: lea[0], chargedOn: jour("2026-09-05"), amountEur: 22.99, offer: "Anthropic · ChatGPT Plus", teamAlias: "R&D", late: false }],
        },
        {
          uid: "pmartin", name: "Paul Martin", email: "pmartin@linagora.com", totalEur: 43.2,
          charges: [
            { id: paul[0], chargedOn: jour("2026-08-20"), amountEur: 21.6, offer: "Anthropic · Claude Pro", teamAlias: "R&D", late: true },
            { id: paul[1], chargedOn: jour("2026-09-20"), amountEur: 21.6, offer: "Anthropic · Claude Pro", teamAlias: "R&D", late: false },
          ],
        },
        {
          uid: "zeta", name: null, email: "zeta@linagora.com", totalEur: 18,
          charges: [{ id: zeta[0], chargedOn: jour("2026-09-30"), amountEur: 18, offer: "Anthropic · Kimi", teamAlias: "R&D", late: false }],
        },
      ],
    });
  });

  test("la transmission emporte exactement la liste affichée : elle en sort et forme une transmission datée, avec son total ; un retard déclaré ensuite revient au mois suivant", async () => {
    const { paul } = await situation();
    const ids = (await listChargesToReimburse(deps, admin, "2026-09")).employees.flatMap((e) => e.charges.map((c) => c.id));
    const id = await transmitCharges(deps, admin, { month: "2026-09", chargeIds: ids });

    expect(await listChargesToReimburse(deps, admin, "2026-09")).toEqual({ month: "2026-09", count: 0, totalEur: 0, employees: [] });
    expect(await listTransmissions(deps, admin)).toEqual([
      { id, month: "2026-09", transmittedAt: new Date("2026-10-02T09:00:00Z"), transmittedBy: "jdupont", chargeCount: 4, totalEur: 84.19 },
    ]);
    expect((await listAudit(testDb)).find((e) => e.action === "CHARGES_TRANSMITTED")).toMatchObject({
      actorUid: "jdupont", targetId: id, details: { mois: "2026-09", nombre: 4, total: 84.19 },
    });

    // Déclaré après la transmission, un prélèvement de septembre revient, en retard, dans la liste d'octobre.
    const [tardif] = await abonnement({ uid: "tardif", name: "Tom Tardif" }, "Claude Max", 108, ["2026-09-15"]);
    const octobre = await listChargesToReimburse(deps, admin, "2026-10");
    expect(octobre.employees.flatMap((e) => e.charges.map((c) => [c.id, c.late]))).toEqual([
      [paul[2], false],
      [tardif, true],
    ]);
  });

  test("une liste changée entre-temps (prélèvement déjà transmis, ou postérieur au mois) est refusée sans rien transmettre ; une liste vide aussi", async () => {
    const { paul, lea } = await situation();
    await transmitCharges(deps, admin, { month: "2026-09", chargeIds: [lea[0]] });
    await expect(transmitCharges(deps, admin, { month: "2026-09", chargeIds: [paul[1], lea[0]] })).rejects.toMatchObject({ code: "liste_changee" });
    await expect(transmitCharges(deps, admin, { month: "2026-09", chargeIds: [paul[1], paul[2]] })).rejects.toMatchObject({ code: "liste_changee" });
    await expect(transmitCharges(deps, admin, { month: "2026-09", chargeIds: [] })).rejects.toMatchObject({ code: "rien_a_transmettre" });
    expect((await listChargesToReimburse(deps, admin, "2026-09")).count).toBe(3);
    expect(await listTransmissions(deps, admin)).toHaveLength(1);
  });

  test("le CSV d'une transmission : une ligne par prélèvement, séparateur « ; », virgule décimale, dates JJ/MM/AAAA, formules neutralisées", async () => {
    const lea = await abonnement({ uid: "lbernard", name: "Léa Bernard" }, "ChatGPT Plus", 22.99, ["2026-09-05"]);
    const piege = await abonnement({ uid: "piege", name: "=HYPERLINK(\"x\")" }, "Offre ; spéciale", 10, ["2026-09-10"]);
    const id = await transmitCharges(deps, admin, { month: "2026-09", chargeIds: [...lea, ...piege] });
    expect(await transmissionCsv(deps, admin, id)).toEqual({
      fileName: "remboursements-2026-09-transmis-le-2026-10-02.csv",
      content:
        "﻿" +
        [
          "Collaborateur;Identifiant;Adresse;Offre;Équipe;Date du prélèvement;Montant TTC (€)",
          "\"'=HYPERLINK(\"\"x\"\")\";piege;piege@linagora.com;\"Anthropic · Offre ; spéciale\";R&D;10/09/2026;10,00",
          "Léa Bernard;lbernard;lbernard@linagora.com;Anthropic · ChatGPT Plus;R&D;05/09/2026;22,99",
        ].join("\r\n") +
        "\r\n",
    });
  });

  test("réservé aux admins ; un mois mal formé et une transmission inconnue sont refusés", async () => {
    await expect(listChargesToReimburse(deps, collaborateur, "2026-09")).rejects.toMatchObject({ code: "interdit" });
    await expect(transmitCharges(deps, collaborateur, { month: "2026-09", chargeIds: ["x"] })).rejects.toMatchObject({ code: "interdit" });
    await expect(listTransmissions(deps, collaborateur)).rejects.toMatchObject({ code: "interdit" });
    await expect(transmissionCsv(deps, collaborateur, "x")).rejects.toMatchObject({ code: "interdit" });
    await expect(listChargesToReimburse(deps, admin, "2026-13")).rejects.toMatchObject({ code: "mois_invalide" });
    await expect(transmissionCsv(deps, admin, "inconnue")).rejects.toMatchObject({ code: "introuvable" });
  });
});
