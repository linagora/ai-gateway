import { z } from "zod";
import { DUREES_VALIDITE } from "@/lib/durees";
import { PortalError } from "@/lib/errors";
import { DATA_LEVELS } from "@/lib/policy";
import type { KeyRequestInput } from "@/lib/services/requests";

/**
 * Saisies de l'API d'intégration (contrat openapi-v1.json) : bornées, sans champ inconnu. L'engagement est facultatif
 * ici : son absence est refusée par le service, avec le même message que dans le portail (engagement_requis).
 */
const texte = (maximum: number) => z.string().trim().min(1).max(maximum);
const identifiant = z.string().min(1).max(200);

/** Identifiant d'une demande dans les chemins de l'API ; un identifiant mal formé est une demande introuvable. */
export function idDeDemande(id: string): string {
  if (!/^[a-z0-9]{1,64}$/.test(id)) throw new PortalError("introuvable", "Demande introuvable.", { objet: "demande" });
  return id;
}

export const demandeDAcces = z.strictObject({ teamId: identifiant, justification: texte(2000) });

const champsDeCle = {
  teamId: identifiant,
  dataLevel: z.enum(DATA_LEVELS),
  models: z.array(identifiant).min(1).max(50),
  justification: texte(2000),
  project: z.string().trim().max(200).nullish(),
  requestedDays: z
    .number()
    .int()
    .refine((jours) => (DUREES_VALIDITE as readonly number[]).includes(jours))
    .nullish(),
  commitment: z.boolean().optional(),
};

export const demandeDeCle = z.strictObject({ ...champsDeCle, renewsRequestId: z.string().regex(/^[a-z0-9]{1,64}$/).nullish() });
export const complementDeCle = z.strictObject(champsDeCle);

/** Saisie du service des demandes : le budget n'est pas demandé au collaborateur (le service reprend celui d'un renouvellement). */
export function versDemandeDeCle(saisie: z.infer<typeof complementDeCle>): KeyRequestInput {
  return {
    teamId: saisie.teamId,
    dataLevel: saisie.dataLevel,
    models: saisie.models,
    justification: saisie.justification,
    project: saisie.project || null,
    requestedBudget: null,
    requestedDays: saisie.requestedDays ?? null,
    commitment: saisie.commitment === true,
  };
}
