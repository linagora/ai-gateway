import type { PolicyCheck } from "./policy";

/**
 * Erreur métier ou d'autorisation levée par les cas d'usage. L'interface la traduit d'après son code
 * et ses paramètres (dictionnaires, espace « avis.erreurs ») ; le message reste pour les journaux.
 */
export type PortalErrorCode =
  | "controles_en_echec"
  | "deja_membre"
  | "demande_en_cours"
  | "engagement_requis"
  | "equipe_non_vide"
  | "interdit"
  | "membre_existant"
  | "introuvable"
  | "motif_obligatoire"
  | "nom_equipe_invalide"
  | "nom_equipe_pris"
  | "parametre_manquant"
  | "passerelle_indisponible"
  | "quatre_yeux"
  | "recommandation_hors_cas_usage"
  | "responsable_existant"
  | "salarie_inconnu"
  | "tarif_eur_manquant"
  | "transition_interdite"
  | "trop_de_generations";

export class PortalError extends Error {
  constructor(
    readonly code: PortalErrorCode,
    message: string,
    readonly params: Record<string, string> = {},
  ) {
    super(message);
    this.name = "PortalError";
  }
}

/** Règle 3 : la demande ne passe pas les contrôles ; `failedChecks` liste les contrôles ✘. */
export class PolicyViolationError extends PortalError {
  constructor(readonly failedChecks: PolicyCheck[]) {
    super("controles_en_echec", "La demande ne respecte pas la politique d'accès aux modèles.");
    this.name = "PolicyViolationError";
  }
}
