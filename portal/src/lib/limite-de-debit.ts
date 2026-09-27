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

  /**
   * Enregistre l'événement s'il reste de la place dans la fenêtre, et dit s'il est autorisé. `maximum` remplace celui de
   * la limite pour cet appel (plafond propre à chaque intégration).
   */
  autoriser(cle: string, maintenant: Date, maximum = this.maximum): boolean {
    const recents = this.recents(cle, maintenant);
    if (recents.length >= maximum) return false;
    this.evenements.set(cle, [...recents, maintenant.getTime()]);
    return true;
  }

  /** Millisecondes avant qu'une place se libère dans la fenêtre : 0 s'il en reste une. */
  attente(cle: string, maintenant: Date, maximum = this.maximum): number {
    const recents = this.recents(cle, maintenant);
    return recents.length < maximum ? 0 : recents[recents.length - maximum] + this.fenetreMs - maintenant.getTime();
  }

  /** Événements de la clé encore dans la fenêtre, du plus ancien au plus récent ; les autres sont oubliés. */
  private recents(cle: string, maintenant: Date): number[] {
    const debut = maintenant.getTime() - this.fenetreMs;
    const recents = (this.evenements.get(cle) ?? []).filter((t) => t > debut);
    this.evenements.set(cle, recents);
    return recents;
  }
}
