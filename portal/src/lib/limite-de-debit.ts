/**
 * Limite de fréquence en mémoire, par clé (ici l'uid du titulaire) : au plus `maximum` événements par fenêtre
 * glissante. Le portail tourne en un seul processus : une mémoire locale suffit.
 */
export class LimiteDeDebit {
  private readonly evenements = new Map<string, number[]>();

  constructor(
    private readonly maximum: number,
    private readonly fenetreMs: number,
  ) {}

  /** Enregistre l'événement s'il reste de la place dans la fenêtre, et dit s'il est autorisé. */
  autoriser(cle: string, maintenant: Date): boolean {
    const debut = maintenant.getTime() - this.fenetreMs;
    const recents = (this.evenements.get(cle) ?? []).filter((t) => t > debut);
    if (recents.length >= this.maximum) {
      this.evenements.set(cle, recents);
      return false;
    }
    this.evenements.set(cle, [...recents, maintenant.getTime()]);
    return true;
  }
}
