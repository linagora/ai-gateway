import type { PolicyCheck } from "./policy";

/** Erreur métier ou d'autorisation levée par les cas d'usage ; les Server Actions l'affichent. */
export type PortalErrorCode =
  | "controles_en_echec"
  | "engagement_requis"
  | "interdit"
  | "introuvable"
  | "motif_obligatoire"
  | "tarif_eur_manquant"
  | "transition_interdite";

export class PortalError extends Error {
  constructor(
    readonly code: PortalErrorCode,
    message: string,
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
