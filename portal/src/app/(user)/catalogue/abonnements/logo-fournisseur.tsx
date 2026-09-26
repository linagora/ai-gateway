import Image from "next/image";

/**
 * Logos des fournisseurs d'abonnements (public/fournisseurs), par nom de fournisseur en minuscules : Anthropic et
 * Moonshot AI viennent de Simple Icons (CC0), OpenAI de Wikimedia Commons (domaine public, marque déposée).
 */
const LOGOS: Record<string, string> = {
  anthropic: "/fournisseurs/anthropic.svg",
  "moonshot ai": "/fournisseurs/moonshotai.svg",
  openai: "/fournisseurs/openai.svg",
};

/** Initiales d'un fournisseur sans logo : « DeepSeek » donne « D », « Mistral AI » donne « MA ». */
const initiales = (fournisseur: string) =>
  fournisseur
    .split(/\s+/)
    .filter(Boolean)
    .map((mot) => mot[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** Logo d'un fournisseur, à côté de son nom : décoratif ; à défaut de logo, ses initiales dans une pastille. */
export function LogoFournisseur({ fournisseur }: { fournisseur: string }) {
  const logo = LOGOS[fournisseur.trim().toLowerCase()];
  return logo ? (
    <Image src={logo} alt="" width={40} height={40} unoptimized className="size-10 shrink-0" />
  ) : (
    <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-sm font-semibold text-neutral-700">
      {initiales(fournisseur)}
    </span>
  );
}
