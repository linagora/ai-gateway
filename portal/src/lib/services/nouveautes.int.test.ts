import { beforeEach, describe, expect, test } from "vitest";
import { listAudit } from "./audit";
import { resetDb, testDb } from "@/test/db";
import { creerNouveaute, marquerLue, type NouveauteInput, nouveaute, nouveautesNonLues, nouveautesPourAdmin, publierNouveaute } from "./nouveautes";

beforeEach(resetDb);

const admin = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: true };
const collaborateur = { uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont", isAdmin: false };

/** Date du jour injectée, avancée à la main par les tests. */
let maintenant: Date;
const deps = { db: testDb, now: () => maintenant };

const annonce: NouveauteInput = {
  category: "MODELES",
  titleFr: "Trois modèles d'embeddings au niveau N3",
  summaryFr: "bge-m3, bge-multilingual-gemma2 et Qwen3-Embedding-8B, hébergés en France par OVHcloud.",
  bodyFr: "Les trois modèles s'appellent par /v1/embeddings.",
};

beforeEach(() => {
  maintenant = new Date("2026-10-05T09:00:00Z");
});

describe("publication d'une nouveauté (ticket #130)", () => {
  test("un brouillon n'est ni compté ni listé pour un collaborateur ; publié, il l'est, de la plus récente à la plus ancienne", async () => {
    const premiere = await creerNouveaute(deps, admin, annonce);
    const seconde = await creerNouveaute(deps, admin, { ...annonce, category: "PRIX", titleFr: "Baisse du prix de Kimi K3" });
    expect(await nouveautesNonLues(deps, collaborateur)).toEqual([]);

    await publierNouveaute(deps, admin, premiere);
    maintenant = new Date("2026-10-05T10:00:00Z");
    await publierNouveaute(deps, admin, seconde);

    expect(await nouveautesNonLues(deps, collaborateur)).toEqual([
      { id: seconde, category: "PRIX", publishedAt: new Date("2026-10-05T10:00:00Z"), title: "Baisse du prix de Kimi K3", summary: annonce.summaryFr },
      { id: premiere, category: "MODELES", publishedAt: new Date("2026-10-05T09:00:00Z"), title: annonce.titleFr, summary: annonce.summaryFr },
    ]);
  });
});

describe("lecture d'une nouveauté (ticket #130)", () => {
  test("« J'ai lu » retire la nouveauté des non lues du seul lecteur ; sa page donne son état, non lue puis lue à la date de la première lecture", async () => {
    const id = await creerNouveaute(deps, admin, annonce);
    await publierNouveaute(deps, admin, id);
    expect(await nouveaute(deps, collaborateur, id)).toEqual({
      id,
      category: "MODELES",
      publishedAt: new Date("2026-10-05T09:00:00Z"),
      title: annonce.titleFr,
      summary: annonce.summaryFr,
      body: annonce.bodyFr,
      etat: { statut: "non_lue" },
    });
    maintenant = new Date("2026-10-05T11:00:00Z");
    await marquerLue(deps, collaborateur, id);
    maintenant = new Date("2026-10-05T12:00:00Z");
    await marquerLue(deps, collaborateur, id);
    expect(await nouveautesNonLues(deps, collaborateur)).toEqual([]);
    expect((await nouveaute(deps, collaborateur, id))?.etat).toEqual({ statut: "lue", le: new Date("2026-10-05T11:00:00Z") });
    expect(await nouveautesNonLues(deps, { ...collaborateur, uid: "pmartin" })).toHaveLength(1);
  });

  test("un brouillon ou une nouveauté inconnue n'a pas de page pour un collaborateur, et « J'ai lu » y est refusé", async () => {
    const brouillon = await creerNouveaute(deps, admin, annonce);
    expect(await nouveaute(deps, collaborateur, brouillon)).toBeNull();
    expect(await nouveaute(deps, collaborateur, "inconnue")).toBeNull();
    await expect(marquerLue(deps, collaborateur, brouillon)).rejects.toMatchObject({ code: "introuvable" });
    await expect(marquerLue(deps, collaborateur, "inconnue")).rejects.toMatchObject({ code: "introuvable" });
  });
});

describe("gestion des nouveautés (ticket #130)", () => {
  test("la liste de la gestion donne chaque nouveauté avec son état, la plus récente d'abord : brouillon, ou publiée avec sa date", async () => {
    const publiee = await creerNouveaute(deps, admin, annonce);
    await publierNouveaute(deps, admin, publiee);
    maintenant = new Date("2026-10-05T10:00:00Z");
    const brouillon = await creerNouveaute(deps, admin, { ...annonce, category: "SERVICE", titleFr: "Maintenance de la passerelle" });
    expect(await nouveautesPourAdmin(deps, admin)).toEqual([
      { id: brouillon, category: "SERVICE", title: "Maintenance de la passerelle", publishedAt: null },
      { id: publiee, category: "MODELES", title: annonce.titleFr, publishedAt: new Date("2026-10-05T09:00:00Z") },
    ]);
  });

  test("seul un admin crée, publie ou liste les nouveautés", async () => {
    const id = await creerNouveaute(deps, admin, annonce);
    await expect(creerNouveaute(deps, collaborateur, annonce)).rejects.toMatchObject({ code: "interdit" });
    await expect(publierNouveaute(deps, collaborateur, id)).rejects.toMatchObject({ code: "interdit" });
    await expect(nouveautesPourAdmin(deps, collaborateur)).rejects.toMatchObject({ code: "interdit" });
    expect(await nouveautesNonLues(deps, collaborateur)).toEqual([]);
  });

  test("une catégorie hors de la liste, un champ vide ou trop long est refusé, en nommant le champ", async () => {
    const champsRefuses = async (input: Partial<NouveauteInput>) => {
      try {
        await creerNouveaute(deps, admin, { ...annonce, ...input } as NouveauteInput);
        return [];
      } catch (e) {
        return (e as { issues: { path: string[] }[] }).issues.map((i) => i.path.join("."));
      }
    };
    expect(await champsRefuses({ category: "AUTRE" as NouveauteInput["category"] })).toEqual(["category"]);
    expect(await champsRefuses({ titleFr: "  " })).toEqual(["titleFr"]);
    expect(await champsRefuses({ titleFr: "T".repeat(121), summaryFr: "R".repeat(301), bodyFr: "C".repeat(20_001) })).toEqual(["titleFr", "summaryFr", "bodyFr"]);
    expect(await champsRefuses({ titleFr: "T".repeat(120), summaryFr: "R".repeat(300), bodyFr: "C".repeat(20_000) })).toEqual([]);
  });

  test("la création et la publication sont inscrites au journal d'audit, avec la catégorie et le titre ; les lectures ne le sont pas", async () => {
    const id = await creerNouveaute(deps, admin, annonce);
    await publierNouveaute(deps, admin, id);
    await marquerLue(deps, collaborateur, id);
    expect((await listAudit(testDb)).map((e) => [e.actorUid, e.action, e.targetId, e.details])).toEqual([
      ["mmaudet", "NEWS_CREATED", id, { categorie: "MODELES", titre: annonce.titleFr }],
      ["mmaudet", "NEWS_PUBLISHED", id, { categorie: "MODELES", titre: annonce.titleFr }],
    ]);
  });
});

