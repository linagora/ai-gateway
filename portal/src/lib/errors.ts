import type { PolicyCheck } from "./policy";

/**
 * Erreur métier ou d'autorisation levée par les cas d'usage. L'interface la traduit d'après son code
 * et ses paramètres (dictionnaires, espace « avis.erreurs ») ; le message reste pour les journaux.
 */
export type PortalErrorCode =
  | "controles_en_echec"
  | "deja_membre"
  | "engagement_requis"
  | "interdit"
  | "introuvable"
  | "motif_obligatoire"
  | "parametre_manquant"
  | "passerelle_indisponible"
  | "recommandation_hors_cas_usage"
  | "tarif_eur_manquant"
  | "transition_interdite";

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
