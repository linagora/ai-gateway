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

/** Prélèvement à rembourser ; en retard s'il date d'un mois antérieur au mois choisi (déclaration tardive). */
export interface ChargeToReimburse {
  id: string;
  chargedOn: Date;
  amountEur: number;
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
  charges: ChargeToReimburse[];
}

/** Liste à rembourser d'un mois (AAAA-MM) : les collaborateurs, par nom, et le total général. */
export interface ChargesToReimburse {
  month: string;
  count: number;
  totalEur: number;
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
    const groupe = groupes.get(s.holderUid) ?? { uid: s.holderUid, name: s.holderName, email: s.holderEmail, totalEur: 0, charges: [] };
    groupe.charges.push({ id: c.id, chargedOn: c.chargedOn, amountEur: c.amountEur.toNumber(), offer: libelleOffre(s.offer), teamAlias: c.teamAlias, late: c.chargedOn < debut });
    groupes.set(s.holderUid, groupe);
  }
  return [...groupes.values()]
    .map((g) => ({ ...g, totalEur: somme(g.charges.map((c) => c.amountEur)) }))
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
  return { month, count: charges.length, totalEur: somme(charges.map((c) => c.amountEur.toNumber())), employees: parCollaborateur(charges, debut) };
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
  const rows = await deps.db.chargeTransmission.findMany({ orderBy: [{ transmittedAt: "desc" }, { id: "desc" }] });
  return rows.map((t) => ({ id: t.id, month: t.month, transmittedAt: t.transmittedAt, transmittedBy: t.transmittedBy, chargeCount: t.chargeCount, totalEur: t.totalEur.toNumber() }));
}

const ENTETES = ["Collaborateur", "Identifiant", "Adresse", "Offre", "Équipe", "Date du prélèvement", "Montant TTC (€)"];

/** Cellule CSV : une formule de tableur (=, +, -, @ en tête) est neutralisée ; ce qui contient « ; », un guillemet ou un retour à la ligne est mis entre guillemets. */
function cellule(valeur: string): string {
  const texte = /^[=+\-@\t\r]/.test(valeur) ? `'${valeur}` : valeur;
  return /[;"\r\n]/.test(texte) ? `"${texte.replaceAll('"', '""')}"` : texte;
}

const jourFr = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;

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
    e.charges.map((c) => [...[e.name ?? "", e.uid, e.email, c.offer, c.teamAlias].map(cellule), jourFr(c.chargedOn), c.amountEur.toFixed(2).replace(".", ",")].join(";")),
  );
  return {
    fileName: `remboursements-${t.month}-transmis-le-${t.transmittedAt.toISOString().slice(0, 10)}.csv`,
    content: `﻿${[ENTETES.join(";"), ...lignes].join("\r\n")}\r\n`,
  };
}
