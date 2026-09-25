import { UseCase } from "@/generated/prisma/enums";

export { UseCase };

/** Cas d'usage (glossaire) : liste fermée commune à tous les modèles, dans l'ordre d'affichage. */
export const USE_CASES: readonly UseCase[] = Object.values(UseCase);
