import type { DataLevel } from "@/lib/policy";

/** Couleur d'un niveau, toujours accompagnée de son nom (jamais la couleur seule). */
export const COULEURS_NIVEAUX: Record<DataLevel, string> = {
  N1: "border-green-700",
  N2: "border-amber-700",
  N3: "border-red-700",
  EXP: "border-violet-700",
};
