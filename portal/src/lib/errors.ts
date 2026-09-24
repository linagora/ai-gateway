/** Erreur métier ou d'autorisation levée par les cas d'usage ; les Server Actions l'affichent. */
export type PortalErrorCode = "interdit" | "introuvable" | "tarif_eur_manquant";

export class PortalError extends Error {
  constructor(
    readonly code: PortalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PortalError";
  }
}
