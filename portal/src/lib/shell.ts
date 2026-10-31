/** Texte entre apostrophes pour le shell, où une apostrophe s'écrit '\''. */
export function entreApostrophes(texte: string): string {
  return `'${texte.replaceAll("'", "'\\''")}'`;
}
