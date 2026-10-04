import { Marked } from "marked";
import { espacesInsecables } from "./typographie";

/** Attribut HTML, ou HTML brut à afficher comme du texte : tous les caractères qui le feraient interpréter sont échappés. */
function echapper(texte: string): string {
  return texte.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Texte : comme `echapper`, mais une entité saisie (« &amp; », « &nbsp; ») reste une entité, comme dans marked. */
function echapperTexte(texte: string): string {
  return texte.replace(/&(?!#?\w+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Lien actif : vers le Web (http, https) ou vers une page du portail (adresse relative, mais pas « //hôte »). Un blanc
 * ou une barre oblique inversée, que les navigateurs suppriment ou lisent comme « / », ferait d'une adresse relative
 * une adresse vers un autre hôte (« /\hôte », « /<tabulation>/hôte ») : une telle adresse n'est jamais active.
 */
function lienActif(href: string): boolean {
  if (/[\s\\]/.test(href)) return false;
  return /^https?:\/\/./i.test(href) || /^\/(?!\/)/.test(href);
}

/**
 * Rendu du Markdown saisi par un admin (spécification #124) : le HTML brut s'affiche comme du texte, une image comme
 * son texte de remplacement, un lien ni http(s) ni relatif comme son seul texte. Les titres passent un niveau sous le
 * titre de la page ; un saut de ligne simple est gardé. La typographie française s'applique au texte d'un texte français,
 * jamais au code.
 */
function rendu(francais: boolean): Marked {
  return new Marked({
    breaks: true,
    walkTokens: (token) => {
      if (francais && token.type === "text") token.text = espacesInsecables(token.text);
    },
    renderer: {
      html: ({ text }) => echapper(text),
      image: ({ text }) => echapper(text),
      // Après <kbd>, <code>, <pre> ou <script>, marked croit déjà échappé le texte qui suit (« escaped ») et le recopierait
      // tel quel : une balise non fermée (« <img onerror=… ») deviendrait du HTML actif. Le texte est donc toujours échappé.
      text(token) {
        return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : echapperTexte(token.text);
      },
      heading({ tokens, depth }) {
        const niveau = Math.min(depth + 1, 6);
        return `<h${niveau}>${this.parser.parseInline(tokens)}</h${niveau}>\n`;
      },
      link({ href, title, tokens }) {
        const texte = this.parser.parseInline(tokens);
        if (!lienActif(href)) return texte;
        const attributs = [`href="${echapper(href)}"`, title ? `title="${echapper(title)}"` : null, /^https?:/i.test(href) ? 'rel="noopener noreferrer"' : null];
        return `<a ${attributs.filter(Boolean).join(" ")}>${texte}</a>`;
      },
    },
  });
}

const RENDUS = { francais: rendu(true), autre: rendu(false) };

/** HTML d'un texte en Markdown, sûr à insérer dans une page. */
export function texteMisEnForme(markdown: string, { francais }: { francais: boolean }): string {
  return (francais ? RENDUS.francais : RENDUS.autre).parse(markdown, { async: false });
}
