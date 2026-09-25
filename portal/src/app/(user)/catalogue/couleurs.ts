import type { DataLevel } from "@/lib/policy";

/** Bordure aux couleurs d'un niveau (jetons de la charte), toujours accompagnée de son nom (jamais la couleur seule). */
export const COULEURS_NIVEAUX: Record<DataLevel, string> = {
  N1: "border-niveau-n1",
  N2: "border-niveau-n2",
  N3: "border-niveau-n3",
  EXP: "border-niveau-exp",
};
