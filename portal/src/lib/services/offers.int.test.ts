import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { listAudit } from "./audit";
import { type OfferInput, listOffers, listOffersForAdmin, saveOffer } from "./offers";

/* Offres d'abonnement au catalogue (spécification #51, ticket #53). */
const admin = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: true };
const salarie = { uid: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin", isAdmin: false };
const deps = { db: testDb };

const claudeMax: OfferInput = {
  supplier: "Anthropic",
  name: "Claude Max 5x",
  monthlyPriceEur: 108,
  dataLevel: "N1",
  rulesFr: "Désactivez l'entraînement sur vos données dans les paramètres de confidentialité.",
  rulesEn: "Turn off training on your data in the privacy settings.",
  url: "https://claude.com/pricing",
  visible: true,
};

beforeEach(resetDb);

describe("offres d'abonnement au catalogue (ticket #53)", () => {
  test("un admin crée une offre : elle apparaît au catalogue des salariés, avec son prix mensuel TTC, son niveau maximal et ses règles dans leur langue", async () => {
    const id = await saveOffer(deps, admin, claudeMax);
    const attendu = { id, supplier: "Anthropic", name: "Claude Max 5x", monthlyPriceEur: 108, dataLevel: "N1", url: "https://claude.com/pricing" };
    expect(await listOffers(deps, "fr")).toEqual([{ ...attendu, rules: "Désactivez l'entraînement sur vos données dans les paramètres de confidentialité." }]);
    expect(await listOffers(deps, "en")).toEqual([{ ...attendu, rules: "Turn off training on your data in the privacy settings." }]);
  });

  test("un admin modifie puis masque une offre : masquée, elle disparaît du catalogue sans être supprimée", async () => {
    const id = await saveOffer(deps, admin, claudeMax);
    await saveOffer(deps, admin, { ...claudeMax, id, monthlyPriceEur: 120, rulesEn: null });
    expect(await listOffers(deps, "en")).toEqual([expect.objectContaining({ id, monthlyPriceEur: 120, rules: "Désactivez l'entraînement sur vos données dans les paramètres de confidentialité." })]);
    await saveOffer(deps, admin, { ...claudeMax, id, monthlyPriceEur: 120, visible: false });
    expect(await listOffers(deps)).toEqual([]);
    expect(await listOffersForAdmin(deps, admin)).toEqual([expect.objectContaining({ id, name: "Claude Max 5x", monthlyPriceEur: 120, visible: false })]);
  });

  test("seul un admin tient les offres ; une offre sans nom, à prix nul ou au lien non sécurisé est refusée", async () => {
    await expect(saveOffer(deps, salarie, claudeMax)).rejects.toMatchObject({ code: "interdit" });
    await expect(listOffersForAdmin(deps, salarie)).rejects.toMatchObject({ code: "interdit" });
    for (const invalide of [{ name: "  " }, { monthlyPriceEur: 0 }, { url: "http://claude.com" }]) {
      await expect(saveOffer(deps, admin, { ...claudeMax, ...invalide })).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(await listOffersForAdmin(deps, admin)).toEqual([]);
  });

  test("chaque création, modification ou masquage d'une offre est inscrit au journal d'audit", async () => {
    const id = await saveOffer(deps, admin, claudeMax);
    await saveOffer(deps, admin, { ...claudeMax, id, visible: false });
    expect((await listAudit(testDb)).map((e) => [e.actorUid, e.action, e.targetId, e.details])).toEqual([
      ["jdupont", "OFFER_CREATED", id, { fournisseur: "Anthropic", offre: "Claude Max 5x", prix: 108, niveau: "N1", visible: true }],
      ["jdupont", "OFFER_UPDATED", id, { fournisseur: "Anthropic", offre: "Claude Max 5x", prix: 108, niveau: "N1", visible: false }],
    ]);
  });
});

