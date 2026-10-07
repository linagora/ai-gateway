import { beforeEach, describe, expect, test } from "vitest";
import { resetDb, testDb } from "@/test/db";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { FakeMailer } from "@/test/fake-mailer";
import { ABSENT_DE_LA_PASSERELLE, etatDesModeles, superviserModeles, sonderMaintenant } from "./supervision";

beforeEach(resetDb);

const admin = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: true };
const collaborateur = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: false };

let litellm: FakeLiteLLM;
let mailer: FakeMailer;
let maintenant: Date;
const deps = () => ({
  db: testDb,
  litellm,
  mailer,
  adminEmails: ["admins@linagora.com"],
  portalUrl: "https://ai-gateway.linagora.com",
  intervalleMinutes: 10,
  now: () => maintenant,
});

/** Fiche du catalogue, visible par défaut. */
async function fiche(modelName: string, displayNameFr: string, visible = true) {
  await testDb.catalogEntry.create({
    data: {
      modelName,
      displayNameFr,
      shortDescriptionFr: "Modèle",
      longDescriptionFr: "Modèle de test.",
      dataLevel: "N1",
      visible,
      updatedBy: admin.uid,
    },
  });
}

/** Passage de la supervision, 5 minutes après le précédent. */
async function passageSuivant() {
  maintenant = new Date(maintenant.getTime() + 5 * 60_000);
  return superviserModeles(deps());
}

beforeEach(async () => {
  maintenant = new Date("2026-10-07T10:00:00Z");
  mailer = new FakeMailer();
  litellm = new FakeLiteLLM()
    .withModel({ modelName: "qwen3.8" })
    .withModel({ modelName: "bge-m3", apiKind: "embeddings" })
    .withModel({ modelName: "jev-latest", apiKind: "decision" })
    .withModel({ modelName: "flux-2-pro", apiKind: "image" })
    .withModel({ modelName: "cache", apiKind: "conversation" });
  await fiche("qwen3.8", "Qwen 3.8 27B");
  await fiche("bge-m3", "BGE-M3");
  await fiche("jev-latest", "JEV");
  await fiche("flux-2-pro", "FLUX.2 [pro]");
  await fiche("cache", "Modèle masqué", false);
});

describe("supervision des modèles", () => {
  test("seuls les modèles visibles sont sondés, chacun selon son type d'API, sans liste écrite dans le code ; un modèle d'images ne l'est pas", async () => {
    const rapport = await superviserModeles(deps());
    expect(litellm.sondes.sort((a, b) => a.modelName.localeCompare(b.modelName))).toEqual([
      { modelName: "bge-m3", apiKind: "embeddings" },
      { modelName: "jev-latest", apiKind: "decision" },
      { modelName: "qwen3.8", apiKind: "conversation" },
    ]);
    expect(rapport).toEqual({ sondes: 3, enPanne: [], nonSupervises: ["flux-2-pro"], alertesPanne: [], retablissements: [] });
    expect(mailer.outbox).toEqual([]);

    // Un modèle rendu visible au catalogue est sondé dès le passage suivant.
    await testDb.catalogEntry.update({ where: { modelName: "cache" }, data: { visible: true } });
    expect((await superviserModeles(deps())).sondes).toBe(4);
  });

  test("après deux échecs consécutifs, un seul courriel aux admins pour tous les modèles tombés ; puis un au rétablissement", async () => {
    litellm.modelesEnPanne.set("qwen3.8", "Provider returned error");
    litellm.modelesEnPanne.set("bge-m3", "aucune réponse en 30 s");

    expect((await superviserModeles(deps())).alertesPanne).toEqual([]);
    const rapport = await passageSuivant();
    expect(rapport.alertesPanne).toEqual(["bge-m3", "qwen3.8"]);
    expect(rapport.enPanne).toEqual([
      { modelName: "bge-m3", error: "aucune réponse en 30 s" },
      { modelName: "qwen3.8", error: "Provider returned error" },
    ]);
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.outbox[0].to).toEqual(["admins@linagora.com"]);
    expect(mailer.outbox[0].subject).toBe("[AI GATEWAY] 2 modèles en panne / 2 models down");
    expect(mailer.outbox[0].text).toContain("- Qwen 3.8 27B (qwen3.8) : Provider returned error");
    expect(mailer.outbox[0].text).toContain("après plusieurs essais à 10 minutes d'intervalle");
    expect(mailer.outbox[0].text).toContain("https://ai-gateway.linagora.com/gestion/supervision");

    // La panne dure : pas de nouveau courriel.
    await passageSuivant();
    expect(mailer.outbox).toHaveLength(1);

    litellm.modelesEnPanne.clear();
    expect((await passageSuivant()).retablissements).toEqual(["bge-m3", "qwen3.8"]);
    expect(mailer.outbox).toHaveLength(2);
    expect(mailer.outbox[1].subject).toBe("[AI GATEWAY] 2 modèles rétablis / 2 models restored");
  });

  test("LiteLLM injoignable ou modèle visible absent de LiteLLM : le modèle est en panne", async () => {
    litellm.models = litellm.models.filter((m) => m.modelName !== "jev-latest");
    await superviserModeles(deps());
    const rapport = await passageSuivant();
    expect(rapport.enPanne).toEqual([{ modelName: "jev-latest", error: ABSENT_DE_LA_PASSERELLE }]);
    expect(mailer.outbox[0].subject).toBe("[AI GATEWAY] Modèle en panne : JEV / Model down: JEV");

    litellm.listModels = async () => {
      throw new Error("LiteLLM injoignable");
    };
    expect((await superviserModeles(deps())).enPanne.map((m) => m.modelName)).toEqual(["bge-m3", "flux-2-pro", "jev-latest", "qwen3.8"]);
  });

  test("un modèle masqué au catalogue n'est plus suivi", async () => {
    await superviserModeles(deps());
    await testDb.catalogEntry.update({ where: { modelName: "qwen3.8" }, data: { visible: false } });
    await superviserModeles(deps());
    expect(await testDb.modelHealth.findUnique({ where: { modelName: "qwen3.8" } })).toBeNull();
  });

  test("l'onglet « Supervision » montre les modèles en panne d'abord ; il est réservé aux admins, comme la sonde immédiate", async () => {
    litellm.modelesEnPanne.set("jev-latest", "Provider returned error");
    await superviserModeles(deps());
    await passageSuivant();
    const etats = await etatDesModeles(deps(), admin, "fr");
    expect(etats.map((e) => [e.modelName, e.statut])).toEqual([
      ["jev-latest", "en_panne"],
      ["bge-m3", "ok"],
      ["qwen3.8", "ok"],
      ["flux-2-pro", "non_supervise"],
    ]);
    expect(etats[0]).toMatchObject({ since: new Date("2026-10-07T10:00:00Z"), alertedAt: new Date("2026-10-07T10:05:00Z"), httpStatus: 502 });

    await expect(etatDesModeles(deps(), collaborateur, "fr")).rejects.toThrow("réservée aux administrateurs");
    await expect(sonderMaintenant(deps(), collaborateur)).rejects.toThrow("réservée aux administrateurs");
  });
});
