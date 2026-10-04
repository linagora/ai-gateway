import { Marked } from "marked";
import { espacesInsecables } from "./typographie";

/** Texte ou attribut HTML : les caractères qui le feraient interpréter comme du HTML sont échappés. */
function echapper(texte: string): string {
  return texte.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Lien actif : vers le Web (http, https) ou vers une page du portail (adresse relative, mais pas « //hôte »). */
function lienActif(href: string): boolean {
  return /^https?:\/\//i.test(href) || (href.startsWith("/") && !href.startsWith("//"));
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
