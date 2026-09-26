import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import type { Langue } from "@/lib/langue";
import { DATA_LEVELS, type DataLevel } from "@/lib/policy";
import { requireAdmin } from "@/lib/rbac";
import { recordAudit } from "./audit";

/** Dépendances du service des offres d'abonnement : tenues par le portail seul. */
export interface OfferDeps {
  db: Db;
}

const texte = z.string().trim().min(1);
const texteFacultatif = z
  .string()
  .trim()
  .nullish()
  .transform((v) => v || null);

/**
 * Offre d'abonnement saisie par un admin (spécification #51) : fournisseur, nom, prix mensuel TTC en euros, niveau
 * maximal (Expérimental : données publiques seulement), règles d'usage en français et, facultatives, en anglais, lien
 * vers la page de l'offre chez le fournisseur. Sans `id`, c'est une création.
 */
export const offerInputSchema = z.object({
  id: z.string().min(1).optional(),
  supplier: texte,
  name: texte,
  monthlyPriceEur: z.number().positive(),
  dataLevel: z.enum(DATA_LEVELS),
  rulesFr: texte,
  rulesEn: texteFacultatif,
  url: z.url({ protocol: /^https$/ }).nullish().transform((v) => v || null),
  visible: z.boolean(),
});

export type OfferInput = z.input<typeof offerInputSchema>;

/** Offre telle que la voit un salarié au catalogue : ses règles dans sa langue (en français à défaut). */
export interface CatalogOffer {
  id: string;
  supplier: string;
  name: string;
  monthlyPriceEur: number;
  dataLevel: DataLevel;
  rules: string;
  url: string | null;
}

/** Offre telle que la tient un admin : tous ses champs, masquée ou non. */
export interface AdminOffer extends Omit<CatalogOffer, "rules"> {
  rulesFr: string;
  rulesEn: string | null;
  visible: boolean;
}

/** Nom d'une offre tel que le montrent les listes et les courriels : « Anthropic · Claude Max 5x ». */
export const libelleOffre = (offre: { supplier: string; name: string }) => `${offre.supplier} · ${offre.name}`;

/** Offres visibles au catalogue, par fournisseur puis par nom. */
export async function listOffers(deps: OfferDeps, language: Langue = "fr"): Promise<CatalogOffer[]> {
  const offres = await deps.db.subscriptionOffer.findMany({ where: { visible: true }, orderBy: [{ supplier: "asc" }, { name: "asc" }] });
  return offres.map((o) => ({
    id: o.id,
    supplier: o.supplier,
    name: o.name,
    monthlyPriceEur: o.monthlyPriceEur.toNumber(),
    dataLevel: o.dataLevel,
    rules: language === "en" ? (o.rulesEn ?? o.rulesFr) : o.rulesFr,
    url: o.url,
  }));
}

/** Toutes les offres, masquées comprises, pour la gestion du catalogue : réservé aux admins. */
export async function listOffersForAdmin(deps: OfferDeps, actor: SessionUser): Promise<AdminOffer[]> {
  requireAdmin(actor);
  const offres = await deps.db.subscriptionOffer.findMany({ orderBy: [{ supplier: "asc" }, { name: "asc" }] });
  return offres.map((o) => ({
    id: o.id,
    supplier: o.supplier,
    name: o.name,
    monthlyPriceEur: o.monthlyPriceEur.toNumber(),
    dataLevel: o.dataLevel,
    rulesFr: o.rulesFr,
    rulesEn: o.rulesEn,
    url: o.url,
    visible: o.visible,
  }));
}

/**
 * Crée ou modifie une offre d'abonnement (un admin seulement) ; la masquer, c'est la rendre invisible, sans la supprimer.
 * Chaque enregistrement est inscrit au journal d'audit. Rend l'identifiant de l'offre.
 */
export async function saveOffer(deps: OfferDeps, actor: SessionUser, input: OfferInput): Promise<string> {
  requireAdmin(actor);
  const { id, ...offre } = offerInputSchema.parse(input);
  const data = { ...offre, updatedBy: actor.uid };
  const enregistree = id ? await deps.db.subscriptionOffer.update({ where: { id }, data }) : await deps.db.subscriptionOffer.create({ data });
  await recordAudit(deps.db, {
    actorUid: actor.uid,
    action: id ? "OFFER_UPDATED" : "OFFER_CREATED",
    targetId: enregistree.id,
    details: { fournisseur: offre.supplier, offre: offre.name, prix: offre.monthlyPriceEur, niveau: offre.dataLevel, visible: offre.visible },
  });
  return enregistree.id;
}
