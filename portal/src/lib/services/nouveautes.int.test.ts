import { beforeEach, describe, expect, test } from "vitest";
import { listAudit } from "./audit";
import { resetDb, testDb } from "@/test/db";
import {
  archiveNouveautes,
  creerNouveaute,
  marquerLue,
  modifierNouveaute,
  type NouveauteInput,
  nouveaute,
  nouveautePourAdmin,
  nouveautesNonLues,
  nouveautesPourAdmin,
  publierNouveaute,
  supprimerNouveaute,
} from "./nouveautes";

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
      html: "<p>Les trois modèles s&#39;appellent par /v1/embeddings.</p>\n",
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
      { id: brouillon, category: "SERVICE", title: "Maintenance de la passerelle", publishedAt: null, lectures: 0 },
      { id: publiee, category: "MODELES", title: annonce.titleFr, publishedAt: new Date("2026-10-05T09:00:00Z"), lectures: 0 },
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

describe("archive des nouveautés (ticket #131)", () => {
  test("l'archive donne les nouveautés publiées, la plus récente d'abord, avec leur état pour le collaborateur, par pages de 50", async () => {
    const publiees: string[] = [];
    for (let i = 0; i < 51; i++) {
      maintenant = new Date(Date.UTC(2026, 9, 5, 9, i));
      const id = await creerNouveaute(deps, admin, { ...annonce, titleFr: `Annonce ${i}` });
      await publierNouveaute(deps, admin, id);
      publiees.push(id);
    }
    await creerNouveaute(deps, admin, { ...annonce, titleFr: "Brouillon" });
    maintenant = new Date("2026-10-06T08:00:00Z");
    await marquerLue(deps, collaborateur, publiees[50]);

    const premiere = await archiveNouveautes(deps, collaborateur, 1);
    expect([premiere.page, premiere.pages, premiere.total, premiere.elements.length]).toEqual([1, 2, 51, 50]);
    expect(premiere.elements.slice(0, 2)).toEqual([
      expect.objectContaining({ id: publiees[50], title: "Annonce 50", etat: { statut: "lue", le: new Date("2026-10-06T08:00:00Z") } }),
      expect.objectContaining({ id: publiees[49], title: "Annonce 49", etat: { statut: "non_lue" } }),
    ]);
    const seconde = await archiveNouveautes(deps, collaborateur, 2);
    expect(seconde.elements.map((n) => n.title)).toEqual(["Annonce 0"]);
    expect((await archiveNouveautes(deps, collaborateur, 9)).page).toBe(2);
  });
});

describe("fenêtre des 30 jours (ticket #135)", () => {
  /** Nouveauté publiée à la date donnée. */
  async function publieeLe(date: string, titre: string): Promise<string> {
    maintenant = new Date(date);
    const id = await creerNouveaute(deps, admin, { ...annonce, titleFr: titre });
    await publierNouveaute(deps, admin, id);
    return id;
  }

  test("à sa première visite, un collaborateur ne voit comme non lues que les nouveautés publiées au plus tôt 30 jours avant ; les plus anciennes sont antérieures", async () => {
    const ancienne = await publieeLe("2026-09-03T09:00:00Z", "Publiée 31 jours avant");
    const recente = await publieeLe("2026-09-05T09:00:00Z", "Publiée 29 jours avant");
    maintenant = new Date("2026-10-04T09:00:00Z");
    expect((await nouveautesNonLues(deps, collaborateur)).map((n) => n.title)).toEqual(["Publiée 29 jours avant"]);
    const suivante = await publieeLe("2026-10-04T10:00:00Z", "Publiée après");
    expect((await nouveautesNonLues(deps, collaborateur)).map((n) => n.title)).toEqual(["Publiée après", "Publiée 29 jours avant"]);
    expect((await nouveaute(deps, collaborateur, ancienne))?.etat).toEqual({ statut: "anterieure" });
    expect(Object.fromEntries((await archiveNouveautes(deps, collaborateur)).elements.map((n) => [n.id, n.etat.statut]))).toEqual({
      [suivante]: "non_lue",
      [recente]: "non_lue",
      [ancienne]: "anterieure",
    });
  });

  test("la première visite ne s'enregistre qu'une fois : la fenêtre ne glisse pas avec les visites suivantes", async () => {
    const id = await publieeLe("2026-09-20T09:00:00Z", "Publiée 14 jours avant la première visite");
    maintenant = new Date("2026-10-04T09:00:00Z");
    expect(await nouveautesNonLues(deps, collaborateur)).toHaveLength(1);
    maintenant = new Date("2026-11-15T09:00:00Z");
    expect((await nouveautesNonLues(deps, collaborateur)).map((n) => n.id)).toEqual([id]);
    expect(await nouveautesNonLues(deps, { ...collaborateur, uid: "nouvel-arrivant" })).toEqual([]);
  });
});

describe("texte mis en forme (ticket #132)", () => {
  /** Texte d'une nouveauté publiée, tel que sa page l'affiche. */
  async function rendu(bodyFr: string): Promise<string> {
    const id = await creerNouveaute(deps, admin, { ...annonce, bodyFr });
    await publierNouveaute(deps, admin, id);
    return (await nouveaute(deps, collaborateur, id))?.html ?? "";
  }

  test("le Markdown est rendu : titres décalés sous le titre de la page, listes, gras, italique, code, citations", async () => {
    const html = await rendu("# Ce qui change\n\n- bge-m3\n- Qwen3-Embedding-8B\n\n**Prix** en *euros*, par `/v1/embeddings`.\n\n> Hébergés en France.");
    expect(html).toContain("<h2>Ce qui change</h2>");
    expect(html).toContain("<li>bge-m3</li>");
    expect(html).toContain("<strong>Prix</strong>");
    expect(html).toContain("<em>euros</em>");
    expect(html).toContain("<code>/v1/embeddings</code>");
    expect(html).toContain("<blockquote>");
  });

  test("le HTML brut s'affiche comme du texte, et une image n'est pas rendue", async () => {
    const html = await rendu('<script>alert("piège")</script>\n\nAvant <b onclick="x()">gras</b> après.\n\n![logo](https://exemple.org/logo.png)');
    expect(html).not.toMatch(/<script|<b |<img/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b onclick=");
    expect(html).toContain("logo");
  });

  test("seuls les liens http(s) et les liens vers une page du portail sont actifs", async () => {
    const html = await rendu(
      "[la fiche](/catalogue/n3?modele=bge-m3), [OVHcloud](https://www.ovhcloud.com), [piège](javascript:alert(1)), [données](data:text/html,x), [ailleurs](//exemple.org)",
    );
    expect(html).toContain('<a href="/catalogue/n3?modele=bge-m3">la fiche</a>');
    expect(html).toContain('<a href="https://www.ovhcloud.com" rel="noopener noreferrer">OVHcloud</a>');
    expect(html).not.toMatch(/javascript:|data:|\/\/exemple\.org/);
    expect(html).toContain("piège");
    expect(html).toContain("données");
    expect(html).toContain("ailleurs");
  });

  test("la typographie française s'applique au texte, pas au code", async () => {
    const html = await rendu("Attention : coupure dimanche ! Code : `a ? b : c`");
    expect(html).toContain("Attention\u00a0: coupure dimanche\u00a0!");
    expect(html).toContain("<code>a ? b : c</code>");
  });
});

describe("nouveautés en anglais (ticket #133)", () => {
  test("en anglais, chaque champ traduit s'affiche en anglais, les autres en français", async () => {
    const id = await creerNouveaute(deps, admin, { ...annonce, titleEn: "Three embedding models at level N3", summaryEn: null, bodyEn: "" });
    await publierNouveaute(deps, admin, id);
    expect(await nouveautesNonLues(deps, collaborateur, "en")).toEqual([expect.objectContaining({ title: "Three embedding models at level N3", summary: annonce.summaryFr })]);
    expect(await nouveaute(deps, collaborateur, id, "en")).toMatchObject({ title: "Three embedding models at level N3", html: expect.stringContaining("Les trois modèles") });
    expect((await archiveNouveautes(deps, collaborateur, 1, "en")).elements[0].title).toBe("Three embedding models at level N3");
    expect((await nouveaute(deps, collaborateur, id, "fr"))?.title).toBe(annonce.titleFr);
  });

  test("le titre et le résumé affichés en français prennent la typographie française, pas ceux affichés en anglais", async () => {
    const id = await creerNouveaute(deps, admin, { ...annonce, titleFr: "Nouveau : bge-m3", summaryFr: "Prix : en baisse !", titleEn: "New: bge-m3" });
    await publierNouveaute(deps, admin, id);
    expect(await nouveautesNonLues(deps, collaborateur, "fr")).toEqual([expect.objectContaining({ title: "Nouveau\u00a0: bge-m3", summary: "Prix\u00a0: en baisse\u00a0!" })]);
    expect(await nouveautesNonLues(deps, collaborateur, "en")).toEqual([expect.objectContaining({ title: "New: bge-m3", summary: "Prix\u00a0: en baisse\u00a0!" })]);
  });

  test("la typographie française ne s'applique qu'à un texte français", async () => {
    const id = await creerNouveaute(deps, admin, { ...annonce, bodyFr: "Attention : coupure.", bodyEn: "Note: outage." });
    await publierNouveaute(deps, admin, id);
    expect((await nouveaute(deps, collaborateur, id, "en"))?.html).toBe("<p>Note: outage.</p>\n");
    expect((await nouveaute(deps, collaborateur, id, "fr"))?.html).toBe("<p>Attention\u00a0: coupure.</p>\n");
  });

  test("les champs anglais ont les mêmes longueurs maximales que les champs français", async () => {
    const refus = await creerNouveaute(deps, admin, { ...annonce, titleEn: "T".repeat(121), summaryEn: "R".repeat(301), bodyEn: "C".repeat(20_001) }).catch((e) => e);
    expect((refus as { issues: { path: string[] }[] }).issues.map((i) => i.path.join("."))).toEqual(["titleEn", "summaryEn", "bodyEn"]);
  });
});

describe("gestion complète des nouveautés (ticket #134)", () => {
  test("un admin prévisualise un brouillon, marqué comme tel, sans « J'ai lu » ; un collaborateur ne le voit pas", async () => {
    const id = await creerNouveaute(deps, admin, annonce);
    expect(await nouveaute(deps, admin, id)).toMatchObject({ id, title: annonce.titleFr, publishedAt: null, etat: { statut: "brouillon" } });
    expect(await nouveaute(deps, collaborateur, id)).toBeNull();
  });

  test("corriger une nouveauté publiée garde sa date de publication et ses accusés de lecture : elle ne redevient pas non lue", async () => {
    const id = await creerNouveaute(deps, admin, annonce);
    await publierNouveaute(deps, admin, id);
    maintenant = new Date("2026-10-05T11:00:00Z");
    await marquerLue(deps, collaborateur, id);
    maintenant = new Date("2026-10-06T09:00:00Z");
    await modifierNouveaute(deps, admin, id, { ...annonce, titleFr: "Trois modèles d'embeddings au niveau N3 (corrigé)", titleEn: "Three embedding models" });
    expect(await nouveautesNonLues(deps, collaborateur)).toEqual([]);
    expect(await nouveaute(deps, collaborateur, id)).toMatchObject({
      title: "Trois modèles d'embeddings au niveau N3 (corrigé)",
      publishedAt: new Date("2026-10-05T09:00:00Z"),
      etat: { statut: "lue", le: new Date("2026-10-05T11:00:00Z") },
    });
    expect(await nouveautePourAdmin(deps, admin, id)).toMatchObject({ titleFr: "Trois modèles d'embeddings au niveau N3 (corrigé)", titleEn: "Three embedding models", bodyFr: annonce.bodyFr });
  });

  test("supprimer une nouveauté la retire de la cloche, de l'archive et de la gestion", async () => {
    const id = await creerNouveaute(deps, admin, annonce);
    await publierNouveaute(deps, admin, id);
    await marquerLue(deps, collaborateur, id);
    await supprimerNouveaute(deps, admin, id);
    expect(await nouveaute(deps, collaborateur, id)).toBeNull();
    expect((await archiveNouveautes(deps, collaborateur)).total).toBe(0);
    expect(await nouveautesPourAdmin(deps, admin)).toEqual([]);
    await expect(supprimerNouveaute(deps, admin, id)).rejects.toMatchObject({ code: "introuvable" });
  });

  test("la gestion compte les lectures de chaque nouveauté, sans nommer les lecteurs", async () => {
    const id = await creerNouveaute(deps, admin, annonce);
    await publierNouveaute(deps, admin, id);
    for (const uid of ["jdupont", "pmartin"]) await marquerLue(deps, { ...collaborateur, uid }, id);
    expect(await nouveautesPourAdmin(deps, admin)).toEqual([{ id, category: "MODELES", title: annonce.titleFr, publishedAt: new Date("2026-10-05T09:00:00Z"), lectures: 2 }]);
  });

  test("seul un admin corrige ou supprime une nouveauté, et voit ses textes dans les deux langues", async () => {
    const id = await creerNouveaute(deps, admin, annonce);
    await expect(modifierNouveaute(deps, collaborateur, id, annonce)).rejects.toMatchObject({ code: "interdit" });
    await expect(supprimerNouveaute(deps, collaborateur, id)).rejects.toMatchObject({ code: "interdit" });
    await expect(nouveautePourAdmin(deps, collaborateur, id)).rejects.toMatchObject({ code: "interdit" });
  });

  test("la correction et la suppression sont inscrites au journal d'audit, avec la catégorie et le titre", async () => {
    const id = await creerNouveaute(deps, admin, annonce);
    await modifierNouveaute(deps, admin, id, { ...annonce, category: "PRIX", titleFr: "Nouveau titre" });
    await supprimerNouveaute(deps, admin, id);
    expect((await listAudit(testDb)).map((e) => [e.action, e.targetId, e.details])).toEqual([
      ["NEWS_CREATED", id, { categorie: "MODELES", titre: annonce.titleFr }],
      ["NEWS_UPDATED", id, { categorie: "PRIX", titre: "Nouveau titre" }],
      ["NEWS_DELETED", id, { categorie: "PRIX", titre: "Nouveau titre" }],
    ]);
  });
});

