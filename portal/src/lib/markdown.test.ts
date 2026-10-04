import { describe, expect, test } from "vitest";
import { texteMisEnForme } from "./markdown";

/** Rendu d'un texte français, tel que la page d'une nouveauté l'affiche. */
const rendu = (markdown: string) => texteMisEnForme(markdown, { francais: true });

describe("rendu sûr du Markdown saisi par un admin (spécification #124)", () => {
  test("le texte qui suit une balise HTML en ligne reste du texte, même après <kbd>, <code>, <pre> ou <script>", () => {
    // Balise <img non fermée : marked n'y voit pas de HTML, mais du texte, qu'il croit déjà échappé après <kbd>…
    for (const balise of ["kbd", "code", "pre", "script"]) {
      const html = rendu(`Touche <${balise}><img src=x onerror=alert(1)//`);
      expect(html, balise).not.toMatch(/<img|<kbd|<code|<pre|<script/);
      expect(html, balise).toContain("&lt;img src=x onerror=alert(1)//");
    }
  });

  test("un lien relatif qui mènerait hors du portail n'est pas actif : « //hôte », « /\\hôte », ou une adresse à blancs", () => {
    for (const destination of ["//exemple.org", "/\\exemple.org", "/\\/exemple.org", "</\t/exemple.org>"]) {
      expect(rendu(`[ailleurs](${destination})`), destination).not.toContain("<a");
    }
    // Une entité dans l'adresse reste du texte : elle n'y devient pas une tabulation que le navigateur supprimerait.
    expect(rendu("[ailleurs](/&#9;/exemple.org)")).toContain('href="/&amp;#9;/exemple.org"');
    expect(rendu("[la fiche](/catalogue/n3?modele=bge-m3#exemples)")).toContain('<a href="/catalogue/n3?modele=bge-m3#exemples">la fiche</a>');
  });
});
