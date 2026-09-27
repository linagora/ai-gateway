/** Contrôle de politique en échec : son identifiant, et ce qui est en cause (des modèles, par exemple). */
export interface ControleEnEchec {
  id: string;
  offending: string[];
}

/** Paramètres qu'attendent les messages d'erreur (ICU) : sans valeur, la variante par défaut s'affiche. */
const PARAMETRES_ATTENDUS = ["objet", "cas", "modele", "equipe", "champ", "raison", "valeur", "id", "kid", "reason", "claim", "scope"] as const;

/**
 * Paramètres d'un message d'erreur, pour les pages du portail comme pour l'API d'intégration : les détails de l'erreur,
 * les champs d'une saisie invalide et les contrôles en échec nommés dans la langue du lecteur (`libelle` rend le libellé
 * d'un champ ou d'un contrôle, ou null s'il n'en a pas), et une valeur vide pour chaque paramètre attendu absent.
 */
export function parametresDErreur(
  { details = {}, champs = [], controles = [] }: { details?: Record<string, string>; champs?: string[]; controles?: ControleEnEchec[] },
  libelle: (espace: "champs" | "controles", cle: string) => string | null,
): Record<string, string> {
  const nom = (espace: "champs" | "controles", cle: string) => libelle(espace, cle) ?? cle;
  return {
    ...Object.fromEntries(PARAMETRES_ATTENDUS.map((parametre) => [parametre, ""])),
    ...details,
    // Un champ se nomme par le premier segment de son chemin (models.0 : models), une seule fois.
    champs: [...new Set(champs.map((chemin) => chemin.split(".")[0]))].map((champ) => nom("champs", champ)).join(", "),
    controles: controles.map(({ id, offending }) => (offending.length > 0 ? `${nom("controles", id)} (${offending.join(", ")})` : nom("controles", id))).join(" ; "),
  };
}
