import { z } from "zod";
import type { NewsCategory, NewsItem, NewsReceipt } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import { texteMisEnForme } from "@/lib/markdown";
import { espacesInsecables } from "@/lib/typographie";
import { type Page, tranche } from "@/lib/pagination";
import { requireAdmin } from "@/lib/rbac";
import { recordAudit } from "./audit";

/**
 * Nouveautés (spécification #124) : annonces qu'un admin rédige puis publie pour tous les collaborateurs ; la cloche de
 * l'en-tête signale celles qu'un collaborateur n'a pas encore acquittées par « J'ai lu ».
 */
export interface NouveautesDeps {
  db: Db;
  now?: () => Date;
}

/** Catégories d'une nouveauté, dans l'ordre où le formulaire les propose. */
export const CATEGORIES_NOUVEAUTE = ["MODELES", "PRIX", "FONCTIONNALITES", "SERVICE"] as const satisfies readonly NewsCategory[];

const texte = (longueurMaximale: number) => z.string().trim().min(1).max(longueurMaximale);
/** Texte anglais facultatif : une valeur vide vaut absence (l'affichage retombe alors sur le français). */
const texteFacultatif = (longueurMaximale: number) =>
  z
    .string()
    .trim()
    .max(longueurMaximale)
    .nullish()
    .transform((v) => v || null);

export const nouveauteInputSchema = z.object({
  category: z.enum(CATEGORIES_NOUVEAUTE),
  titleFr: texte(120),
  titleEn: texteFacultatif(120),
  /** Résumé du panneau de la cloche : texte brut, sans mise en forme. */
  summaryFr: texte(300),
  summaryEn: texteFacultatif(300),
  /** Texte en Markdown. */
  bodyFr: texte(20_000),
  bodyEn: texteFacultatif(20_000),
});
export type NouveauteInput = z.input<typeof nouveauteInputSchema>;

/** Nouveauté publiée, telle que le panneau de la cloche la résume. */
export interface ResumeNouveaute {
  id: string;
  category: NewsCategory;
  publishedAt: Date;
  title: string;
  summary: string;
}

/** Enregistre un brouillon, invisible des collaborateurs jusqu'à sa publication. Réservé aux admins. */
export async function creerNouveaute(deps: NouveautesDeps, actor: SessionUser, input: NouveauteInput): Promise<string> {
  requireAdmin(actor);
  const nouveaute = nouveauteInputSchema.parse(input);
  const { id } = await deps.db.newsItem.create({ data: { ...nouveaute, createdAt: deps.now?.() ?? new Date(), updatedBy: actor.uid } });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "NEWS_CREATED", targetId: id, details: { categorie: nouveaute.category, titre: nouveaute.titleFr } });
  return id;
}

/**
 * Corrige une nouveauté, brouillon ou publiée : une nouveauté publiée garde sa date de publication et ses accusés de
 * lecture, et ne redevient donc pas non lue. Réservé aux admins.
 */
export async function modifierNouveaute(deps: NouveautesDeps, actor: SessionUser, id: string, input: NouveauteInput): Promise<void> {
  requireAdmin(actor);
  const nouveaute = nouveauteInputSchema.parse(input);
  await existante(deps, id);
  await deps.db.newsItem.update({ where: { id }, data: { ...nouveaute, updatedBy: actor.uid } });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "NEWS_UPDATED", targetId: id, details: { categorie: nouveaute.category, titre: nouveaute.titleFr } });
}

/** Supprime une nouveauté, avec ses accusés de lecture. Réservé aux admins. */
export async function supprimerNouveaute(deps: NouveautesDeps, actor: SessionUser, id: string): Promise<void> {
  requireAdmin(actor);
  const nouveaute = await existante(deps, id);
  await deps.db.newsItem.delete({ where: { id } });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "NEWS_DELETED", targetId: id, details: { categorie: nouveaute.category, titre: nouveaute.titleFr } });
}

/** Nouveauté connue, brouillon ou publiée. */
async function existante(deps: NouveautesDeps, id: string): Promise<NewsItem> {
  const nouveaute = await deps.db.newsItem.findUnique({ where: { id } });
  if (!nouveaute) throw new PortalError("introuvable", `Nouveauté inconnue : ${id}`);
  return nouveaute;
}

/** Publie un brouillon : il apparaît dès lors à tous les collaborateurs. Une nouveauté déjà publiée garde sa date. */
export async function publierNouveaute(deps: NouveautesDeps, actor: SessionUser, id: string): Promise<void> {
  requireAdmin(actor);
  const nouveaute = await existante(deps, id);
  if (nouveaute.publishedAt) return;
  await deps.db.newsItem.update({ where: { id }, data: { publishedAt: deps.now?.() ?? new Date(), updatedBy: actor.uid } });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "NEWS_PUBLISHED", targetId: id, details: { categorie: nouveaute.category, titre: nouveaute.titleFr } });
}

/** Ligne de la gestion des nouveautés : un brouillon n'a pas de date de publication ; ses lecteurs ne sont que comptés. */
export interface NouveauteAdmin {
  id: string;
  category: NewsCategory;
  title: string;
  publishedAt: Date | null;
  lectures: number;
}

/** Toutes les nouveautés, brouillons compris, de la plus récemment créée à la plus ancienne. Réservé aux admins. */
export async function nouveautesPourAdmin(deps: NouveautesDeps, actor: SessionUser): Promise<NouveauteAdmin[]> {
  requireAdmin(actor);
  const rows = await deps.db.newsItem.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }], include: { _count: { select: { receipts: true } } } });
  return rows.map((n) => ({ id: n.id, category: n.category, title: n.titleFr, publishedAt: n.publishedAt, lectures: n._count.receipts }));
}

/** Nouveauté telle que le formulaire de correction la reprend : ses textes dans les deux langues. */
export type NouveauteEditable = Pick<NewsItem, "id" | "category" | "titleFr" | "titleEn" | "summaryFr" | "summaryEn" | "bodyFr" | "bodyEn" | "publishedAt">;

/** Nouveauté à corriger, brouillon ou publiée ; null si elle est inconnue. Réservé aux admins. */
export async function nouveautePourAdmin(deps: NouveautesDeps, actor: SessionUser, id: string): Promise<NouveauteEditable | null> {
  requireAdmin(actor);
  const n = await deps.db.newsItem.findUnique({ where: { id } });
  return n && { id: n.id, category: n.category, titleFr: n.titleFr, titleEn: n.titleEn, summaryFr: n.summaryFr, summaryEn: n.summaryEn, bodyFr: n.bodyFr, bodyEn: n.bodyEn, publishedAt: n.publishedAt };
}

/** Fenêtre d'un nouveau collaborateur : il ne doit acquitter que les nouveautés publiées ces jours-là avant sa première visite. */
const FENETRE_JOURS = 30;

/**
 * Début de la fenêtre du collaborateur : 30 jours avant sa première visite, enregistrée à la première lecture, une seule
 * fois, pour que la fenêtre ne glisse pas. Deux lectures simultanées ne créent qu'une première visite.
 */
async function debutDeFenetre(deps: NouveautesDeps, uid: string): Promise<Date> {
  let visite = await deps.db.firstVisit.findUnique({ where: { uid } });
  if (!visite) {
    await deps.db.firstVisit.createMany({ data: [{ uid, at: deps.now?.() ?? new Date() }], skipDuplicates: true });
    visite = await deps.db.firstVisit.findUniqueOrThrow({ where: { uid } });
  }
  return new Date(visite.at.getTime() - FENETRE_JOURS * 86_400_000);
}

/**
 * Nouveautés publiées dans la fenêtre du collaborateur, qu'il n'a pas acquittées, de la plus récente à la plus
 * ancienne, dans sa langue.
 */
export async function nouveautesNonLues(deps: NouveautesDeps, user: SessionUser, langue: Langue = "fr"): Promise<ResumeNouveaute[]> {
  const debut = await debutDeFenetre(deps, user.uid);
  const rows = await deps.db.newsItem.findMany({
    where: { publishedAt: { gte: debut }, receipts: { none: { uid: user.uid } } },
    orderBy: { publishedAt: "desc" },
  });
  return rows.map((n) => resume(n, langue));
}

/**
 * Texte dans la langue du collaborateur : un texte que l'admin n'a pas traduit s'affiche en français, avec la
 * typographie française, comme tout texte français.
 */
const traduit = (langue: Langue, fr: string, en: string | null) => (langue === "en" && en) || espacesInsecables(fr);

/** Résumé d'une nouveauté publiée, dans la langue du collaborateur. */
function resume(n: NewsItem, langue: Langue): ResumeNouveaute {
  return { id: n.id, category: n.category, publishedAt: n.publishedAt as Date, title: traduit(langue, n.titleFr, n.titleEn), summary: traduit(langue, n.summaryFr, n.summaryEn) };
}

/** État d'une nouveauté publiée pour le collaborateur : lue s'il l'a acquittée, sinon non lue, ou antérieure à sa fenêtre. */
function etat(n: NewsItem & { receipts: NewsReceipt[] }, debut: Date): EtatNouveaute {
  const [accuse] = n.receipts;
  if (accuse) return { statut: "lue", le: accuse.readAt };
  return (n.publishedAt as Date) < debut ? { statut: "anterieure" } : { statut: "non_lue" };
}

/**
 * État d'une nouveauté pour un collaborateur : non lue, lue à la date de son accusé de lecture, ou antérieure à sa
 * fenêtre (publiée plus de 30 jours avant sa première visite : ni non lue, ni à acquitter). Un admin voit aussi un
 * brouillon, en aperçu.
 */
export type EtatNouveaute = { statut: "non_lue" } | { statut: "lue"; le: Date } | { statut: "anterieure" } | { statut: "brouillon" };

/** Page d'une nouveauté : son texte complet, mis en forme (HTML sûr), et son état ; un brouillon n'a pas de date. */
export interface Nouveaute extends Omit<ResumeNouveaute, "publishedAt"> {
  publishedAt: Date | null;
  html: string;
  etat: EtatNouveaute;
}

/**
 * Nouveauté publiée, dans la langue et avec l'état du collaborateur ; pour un admin, un brouillon aussi, en aperçu. Null
 * pour une nouveauté inconnue, ou un brouillon demandé par un collaborateur qui n'est pas admin.
 */
export async function nouveaute(deps: NouveautesDeps, user: SessionUser, id: string, langue: Langue = "fr"): Promise<Nouveaute | null> {
  const [n, debut] = await Promise.all([
    deps.db.newsItem.findUnique({ where: { id }, include: { receipts: { where: { uid: user.uid } } } }),
    debutDeFenetre(deps, user.uid),
  ]);
  if (!n || (!n.publishedAt && !user.isAdmin)) return null;
  const anglais = langue === "en" && n.bodyEn;
  return {
    ...resume(n, langue),
    publishedAt: n.publishedAt,
    html: texteMisEnForme(anglais || n.bodyFr, { francais: !anglais }),
    etat: n.publishedAt ? etat(n, debut) : { statut: "brouillon" },
  };
}

/** Nouveauté de l'archive : son résumé et son état pour le collaborateur. */
export interface NouveauteArchivee extends ResumeNouveaute {
  etat: EtatNouveaute;
}

/** Archive « Toutes les nouveautés » : les nouveautés publiées, de la plus récente à la plus ancienne, par pages. */
export async function archiveNouveautes(deps: NouveautesDeps, user: SessionUser, page = 1, langue: Langue = "fr"): Promise<Page<NouveauteArchivee>> {
  const where = { publishedAt: { not: null } };
  const [total, debut] = await Promise.all([deps.db.newsItem.count({ where }), debutDeFenetre(deps, user.uid)]);
  const { page: courante, pages, skip, take } = tranche(total, page);
  const rows = await deps.db.newsItem.findMany({
    where,
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    skip,
    take,
    include: { receipts: { where: { uid: user.uid } } },
  });
  return { elements: rows.map((n) => ({ ...resume(n, langue), etat: etat(n, debut) })), page: courante, pages, total };
}

/** « J'ai lu » : accusé de lecture d'une nouveauté publiée ; une seconde fois, la date de la première lecture reste. */
export async function marquerLue(deps: NouveautesDeps, user: SessionUser, id: string): Promise<void> {
  const n = await deps.db.newsItem.findUnique({ where: { id } });
  if (!n?.publishedAt) throw new PortalError("introuvable", `Nouveauté publiée inconnue : ${id}`);
  await deps.db.newsReceipt.upsert({
    where: { newsItemId_uid: { newsItemId: id, uid: user.uid } },
    create: { newsItemId: id, uid: user.uid, readAt: deps.now?.() ?? new Date() },
    update: {},
  });
}
