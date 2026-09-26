import writeExcelFile from "write-excel-file/node";
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { PortalError } from "@/lib/errors";
import { requireAdmin } from "@/lib/rbac";
import { recordAudit } from "./audit";
import { libelleOffre } from "./offers";

/**
 * Remboursements (retours de l'utilisateur du 2026-09-26) : les prélèvements des abonnements, que la comptabilité
 * rembourse aux collaborateurs sur la base de leurs déclarations. Chaque mois, un admin transmet à la comptabilité les
 * prélèvements qui restent à transmettre jusqu'à la fin du mois, retards compris ; un prélèvement n'est transmis qu'une
 * fois. Réservé aux admins.
 */
export interface ReimbursementDeps {
  db: Db;
  /** Date du jour, injectée par les tests ; l'heure réelle sinon. */
  now?: () => Date;
}

/** Prélèvement à rembourser, TTC (montant déclaré) et hors taxe ; en retard s'il date d'un mois antérieur au mois choisi (déclaration tardive). */
export interface ChargeToReimburse {
  id: string;
  chargedOn: Date;
  amountEur: number;
  amountHtEur: number;
  offer: string;
  teamAlias: string;
  late: boolean;
}

/** Collaborateur à rembourser : ses prélèvements, du plus ancien au plus récent, et leur total. */
export interface EmployeeToReimburse {
  uid: string;
  name: string | null;
  email: string;
  totalEur: number;
  totalHtEur: number;
  charges: ChargeToReimburse[];
}

/** Liste à rembourser d'un mois (AAAA-MM) : les collaborateurs, par nom, et le total général. */
export interface ChargesToReimburse {
  month: string;
  count: number;
  totalEur: number;
  totalHtEur: number;
  employees: EmployeeToReimburse[];
}

/** Transmission à la comptabilité, telle que l'historique la présente. */
export interface Transmission {
  id: string;
  month: string;
  transmittedAt: Date;
  transmittedBy: string;
  chargeCount: number;
  totalEur: number;
  totalHtEur: number;
}

const moisSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Premier jour du mois AAAA-MM et premier jour du mois suivant, à minuit UTC, comme les dates des prélèvements. */
function bornes(mois: string): { debut: Date; fin: Date } {
  if (!moisSchema.safeParse(mois).success) throw new PortalError("mois_invalide", `Mois invalide : ${mois}.`);
  const [annee, numero] = mois.split("-").map(Number);
  return { debut: new Date(Date.UTC(annee, numero - 1, 1)), fin: new Date(Date.UTC(annee, numero, 1)) };
}

/** Somme de montants en euros, comptée en centimes pour éviter la dérive des nombres à virgule. */
const somme = (montants: number[]) => montants.reduce((total, montant) => total + Math.round(montant * 100), 0) / 100;

/**
 * TVA des abonnements : les montants déclarés sont TTC ; les fournisseurs appliquent aux particuliers la TVA française
 * des services numériques, 20 % (le taux déjà retenu pour les prix des offres).
 */
const TAUX_TVA = 0.2;

/** Montant hors taxe d'un montant TTC, arrondi au centime ; les totaux HT additionnent ces montants arrondis. */
const horsTaxe = (ttc: number) => Math.round((ttc / (1 + TAUX_TVA)) * 100) / 100;

const AVEC_TITULAIRE = { subscription: { include: { offer: true } } } as const;
type ChargeAvecTitulaire = Prisma.SubscriptionChargeGetPayload<{ include: typeof AVEC_TITULAIRE }>;

/**
 * Regroupe des prélèvements, déjà rangés du plus ancien au plus récent, par titulaire ; les titulaires par nom (à défaut,
 * par uid). Un prélèvement antérieur à `debut` est en retard.
 */
function parCollaborateur(charges: ChargeAvecTitulaire[], debut: Date): EmployeeToReimburse[] {
  const groupes = new Map<string, EmployeeToReimburse>();
  for (const c of charges) {
    const s = c.subscription;
    const groupe = groupes.get(s.holderUid) ?? { uid: s.holderUid, name: s.holderName, email: s.holderEmail, totalEur: 0, totalHtEur: 0, charges: [] };
    const amountEur = c.amountEur.toNumber();
    groupe.charges.push({ id: c.id, chargedOn: c.chargedOn, amountEur, amountHtEur: horsTaxe(amountEur), offer: libelleOffre(s.offer), teamAlias: c.teamAlias, late: c.chargedOn < debut });
    groupes.set(s.holderUid, groupe);
  }
  return [...groupes.values()]
    .map((g) => ({ ...g, totalEur: somme(g.charges.map((c) => c.amountEur)), totalHtEur: somme(g.charges.map((c) => c.amountHtEur)) }))
    .sort((a, b) => (a.name ?? a.uid).localeCompare(b.name ?? b.uid, "fr") || a.uid.localeCompare(b.uid, "fr"));
}

/** Prélèvements qui restent à transmettre jusqu'à la fin du mois choisi, retards compris, par collaborateur. */
export async function listChargesToReimburse(deps: ReimbursementDeps, actor: SessionUser, month: string): Promise<ChargesToReimburse> {
  requireAdmin(actor);
  const { debut, fin } = bornes(month);
  const charges = await deps.db.subscriptionCharge.findMany({
    where: { transmissionId: null, chargedOn: { lt: fin } },
    include: AVEC_TITULAIRE,
    orderBy: [{ chargedOn: "asc" }, { id: "asc" }],
  });
  const employees = parCollaborateur(charges, debut);
  const lignes = employees.flatMap((e) => e.charges);
  return { month, count: lignes.length, totalEur: somme(lignes.map((c) => c.amountEur)), totalHtEur: somme(lignes.map((c) => c.amountHtEur)), employees };
}

/**
 * Transmet à la comptabilité exactement les prélèvements donnés (ceux de la liste affichée) : ils doivent rester à
 * transmettre et dater d'avant la fin du mois ; sinon la liste a changé entre-temps et rien n'est transmis. Rend
 * l'identifiant de la transmission.
 */
export async function transmitCharges(deps: ReimbursementDeps, actor: SessionUser, input: { month: string; chargeIds: string[] }): Promise<string> {
  requireAdmin(actor);
  const { fin } = bornes(input.month);
  const ids = [...new Set(input.chargeIds)];
  if (ids.length === 0) throw new PortalError("rien_a_transmettre", "Aucun prélèvement à transmettre.");
  const changee = () => new PortalError("liste_changee", "La liste des prélèvements à transmettre a changé entre-temps.");
  const transmission = await deps.db.$transaction(async (tx) => {
    const charges = await tx.subscriptionCharge.findMany({ where: { id: { in: ids }, transmissionId: null, chargedOn: { lt: fin } }, select: { amountEur: true } });
    if (charges.length !== ids.length) throw changee();
    const t = await tx.chargeTransmission.create({
      data: {
        month: input.month,
        transmittedAt: deps.now?.() ?? new Date(),
        transmittedBy: actor.uid,
        chargeCount: ids.length,
        totalEur: somme(charges.map((c) => c.amountEur.toNumber())),
      },
    });
    // Une transmission concurrente aurait déjà emporté certains prélèvements : tout est alors annulé.
    const { count } = await tx.subscriptionCharge.updateMany({ where: { id: { in: ids }, transmissionId: null }, data: { transmissionId: t.id } });
    if (count !== ids.length) throw changee();
    return t;
  });
  await recordAudit(deps.db, {
    actorUid: actor.uid,
    action: "CHARGES_TRANSMITTED",
    targetId: transmission.id,
    details: { mois: input.month, nombre: transmission.chargeCount, total: transmission.totalEur.toNumber() },
  });
  return transmission.id;
}

/** Historique des transmissions, la plus récente d'abord. */
export async function listTransmissions(deps: ReimbursementDeps, actor: SessionUser): Promise<Transmission[]> {
  requireAdmin(actor);
  const rows = await deps.db.chargeTransmission.findMany({ orderBy: [{ transmittedAt: "desc" }, { id: "desc" }], include: { charges: { select: { amountEur: true } } } });
  return rows.map((t) => ({
    id: t.id,
    month: t.month,
    transmittedAt: t.transmittedAt,
    transmittedBy: t.transmittedBy,
    chargeCount: t.chargeCount,
    totalEur: t.totalEur.toNumber(),
    totalHtEur: somme(t.charges.map((c) => horsTaxe(c.amountEur.toNumber()))),
  }));
}

const ENTETES = ["Collaborateur", "Identifiant", "Adresse", "Offre", "Équipe", "Date du prélèvement", "Montant HT (€)", "Montant TTC (€)"];

/** Cellule CSV : une formule de tableur (=, +, -, @ en tête) est neutralisée ; ce qui contient « ; », un guillemet ou un retour à la ligne est mis entre guillemets. */
function cellule(valeur: string): string {
  const texte = /^[=+\-@\t\r]/.test(valeur) ? `'${valeur}` : valeur;
  return /[;"\r\n]/.test(texte) ? `"${texte.replaceAll('"', '""')}"` : texte;
}

const jourFr = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
const montantFr = (montant: number) => montant.toFixed(2).replace(".", ",");

/**
 * Fichier CSV d'une transmission, pour la comptabilité : une ligne par prélèvement, par collaborateur ; séparateur « ; »,
 * virgule décimale, dates JJ/MM/AAAA, marque d'ordre des octets (UTF-8) et fins de ligne CRLF, pour l'ouvrir tel quel
 * dans un tableur.
 */
export async function transmissionCsv(deps: ReimbursementDeps, actor: SessionUser, id: string): Promise<{ fileName: string; content: string }> {
  requireAdmin(actor);
  const t = await deps.db.chargeTransmission.findUnique({
    where: { id },
    include: { charges: { include: AVEC_TITULAIRE, orderBy: [{ chargedOn: "asc" }, { id: "asc" }] } },
  });
  if (!t) throw new PortalError("introuvable", `Transmission ${id} introuvable.`, { objet: "transmission" });
  const lignes = parCollaborateur(t.charges, new Date(0)).flatMap((e) =>
    e.charges.map((c) => [...[e.name ?? "", e.uid, e.email, c.offer, c.teamAlias].map(cellule), jourFr(c.chargedOn), montantFr(c.amountHtEur), montantFr(c.amountEur)].join(";")),
  );
  return {
    fileName: `remboursements-${t.month}-transmis-le-${t.transmittedAt.toISOString().slice(0, 10)}.csv`,
    content: `﻿${[ENTETES.join(";"), ...lignes].join("\r\n")}\r\n`,
  };
}

const EUROS = "#,##0.00";
const gras = (value: string) => ({ value, fontWeight: "bold" as const });

/**
 * Export Excel de la liste à transmettre d'un mois, sans rien transmettre : une feuille « Prélèvements » (une ligne par
 * prélèvement, retards signalés, total général) et une feuille « Par collaborateur » (nombre de prélèvements et totaux),
 * montants HT et TTC en nombres, dates en dates.
 */
export async function exportChargesToReimburse(deps: ReimbursementDeps, actor: SessionUser, month: string): Promise<{ fileName: string; content: Buffer }> {
  const liste = await listChargesToReimburse(deps, actor, month);
  const montant = (value: number) => ({ value, format: EUROS });
  const prelevements = [
    [...ENTETES, "Déclaré en retard"].map(gras),
    ...liste.employees.flatMap((e) =>
      e.charges.map((c) => [e.name ?? "", e.uid, e.email, c.offer, c.teamAlias, { value: c.chargedOn, format: "dd/mm/yyyy" }, montant(c.amountHtEur), montant(c.amountEur), c.late ? "oui" : ""]),
    ),
    [gras("Total"), "", "", "", "", "", { ...montant(liste.totalHtEur), fontWeight: "bold" as const }, { ...montant(liste.totalEur), fontWeight: "bold" as const }, ""],
  ];
  const parCollaborateur = [
    ["Collaborateur", "Identifiant", "Adresse", "Prélèvements", "Total HT (€)", "Total TTC (€)"].map(gras),
    ...liste.employees.map((e) => [e.name ?? "", e.uid, e.email, e.charges.length, montant(e.totalHtEur), montant(e.totalEur)]),
    [gras("Total"), "", "", liste.count, { ...montant(liste.totalHtEur), fontWeight: "bold" as const }, { ...montant(liste.totalEur), fontWeight: "bold" as const }],
  ];
  const largeurs = (...colonnes: number[]) => colonnes.map((width) => ({ width }));
  const content = await writeExcelFile([
    { data: prelevements, sheet: "Prélèvements", columns: largeurs(24, 18, 30, 34, 22, 14, 14, 14, 12) },
    { data: parCollaborateur, sheet: "Par collaborateur", columns: largeurs(24, 18, 30, 13, 14, 14) },
  ]).toBuffer();
  return { fileName: `remboursements-a-transmettre-${month}.xlsx`, content };
}
