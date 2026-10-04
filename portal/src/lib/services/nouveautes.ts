import { z } from "zod";
import type { NewsCategory, NewsItem, NewsReceipt } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
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

export const nouveauteInputSchema = z.object({
  category: z.enum(CATEGORIES_NOUVEAUTE),
  titleFr: texte(120),
  /** Résumé du panneau de la cloche : texte brut, sans mise en forme. */
  summaryFr: texte(300),
  bodyFr: texte(20_000),
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

/** Publie un brouillon : il apparaît dès lors à tous les collaborateurs. Une nouveauté déjà publiée garde sa date. */
export async function publierNouveaute(deps: NouveautesDeps, actor: SessionUser, id: string): Promise<void> {
  requireAdmin(actor);
  const nouveaute = await deps.db.newsItem.findUnique({ where: { id } });
  if (!nouveaute) throw new PortalError("introuvable", `Nouveauté inconnue : ${id}`);
  if (nouveaute.publishedAt) return;
  await deps.db.newsItem.update({ where: { id }, data: { publishedAt: deps.now?.() ?? new Date(), updatedBy: actor.uid } });
  await recordAudit(deps.db, { actorUid: actor.uid, action: "NEWS_PUBLISHED", targetId: id, details: { categorie: nouveaute.category, titre: nouveaute.titleFr } });
}

/** Ligne de la gestion des nouveautés : un brouillon n'a pas de date de publication. */
export interface NouveauteAdmin {
  id: string;
  category: NewsCategory;
  title: string;
  publishedAt: Date | null;
}

/** Toutes les nouveautés, brouillons compris, de la plus récemment créée à la plus ancienne. Réservé aux admins. */
export async function nouveautesPourAdmin(deps: NouveautesDeps, actor: SessionUser): Promise<NouveauteAdmin[]> {
  requireAdmin(actor);
  const rows = await deps.db.newsItem.findMany({ orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return rows.map((n) => ({ id: n.id, category: n.category, title: n.titleFr, publishedAt: n.publishedAt }));
}

/** Nouveautés publiées que le collaborateur n'a pas acquittées, de la plus récente à la plus ancienne. */
export async function nouveautesNonLues(deps: NouveautesDeps, user: SessionUser): Promise<ResumeNouveaute[]> {
  const rows = await deps.db.newsItem.findMany({
    where: { publishedAt: { not: null }, receipts: { none: { uid: user.uid } } },
    orderBy: { publishedAt: "desc" },
  });
  return rows.map(resume);
}

/** Résumé d'une nouveauté publiée. */
function resume(n: NewsItem): ResumeNouveaute {
  return { id: n.id, category: n.category, publishedAt: n.publishedAt as Date, title: n.titleFr, summary: n.summaryFr };
}

/** État d'une nouveauté d'après l'accusé de lecture du collaborateur, s'il en a un. */
function etat([accuse]: NewsReceipt[]): EtatNouveaute {
  return accuse ? { statut: "lue", le: accuse.readAt } : { statut: "non_lue" };
}

/** État d'une nouveauté pour un collaborateur : non lue, ou lue à la date de son accusé de lecture. */
export type EtatNouveaute = { statut: "non_lue" } | { statut: "lue"; le: Date };

/** Page d'une nouveauté : son texte complet et son état pour le collaborateur. */
export interface Nouveaute extends ResumeNouveaute {
  body: string;
  etat: EtatNouveaute;
}

/** Nouveauté publiée, avec son état pour le collaborateur ; null pour un brouillon ou une nouveauté inconnue. */
export async function nouveaute(deps: NouveautesDeps, user: SessionUser, id: string): Promise<Nouveaute | null> {
  const n = await deps.db.newsItem.findUnique({ where: { id }, include: { receipts: { where: { uid: user.uid } } } });
  if (!n?.publishedAt) return null;
  return { ...resume(n), body: n.bodyFr, etat: etat(n.receipts) };
}

/** Nouveauté de l'archive : son résumé et son état pour le collaborateur. */
export interface NouveauteArchivee extends ResumeNouveaute {
  etat: EtatNouveaute;
}

/** Archive « Toutes les nouveautés » : les nouveautés publiées, de la plus récente à la plus ancienne, par pages. */
export async function archiveNouveautes(deps: NouveautesDeps, user: SessionUser, page = 1): Promise<Page<NouveauteArchivee>> {
  const where = { publishedAt: { not: null } };
  const total = await deps.db.newsItem.count({ where });
  const { page: courante, pages, skip, take } = tranche(total, page);
  const rows = await deps.db.newsItem.findMany({
    where,
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    skip,
    take,
    include: { receipts: { where: { uid: user.uid } } },
  });
  return { elements: rows.map((n) => ({ ...resume(n), etat: etat(n.receipts) })), page: courante, pages, total };
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
