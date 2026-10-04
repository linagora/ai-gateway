import { Boxes, Euro, type LucideIcon, Sparkles, Wrench } from "lucide-react";
import { getTranslations } from "next-intl/server";
import type { NewsCategory } from "@/generated/prisma/client";

/** Pictogrammes des catégories de nouveautés (jeu Lucide), toujours accompagnés de leur libellé. */
const ICONES: Record<NewsCategory, LucideIcon> = { MODELES: Boxes, PRIX: Euro, FONCTIONNALITES: Sparkles, SERVICE: Wrench };

/** Catégorie d'une nouveauté : son pictogramme et son libellé, dans la langue du collaborateur. */
export async function CategorieNouveaute({ category }: { category: NewsCategory }) {
  const domaine = await getTranslations("domaine");
  const Icone = ICONES[category];
  return (
    <span className="inline-flex items-center gap-1">
      <Icone aria-hidden="true" className="size-4 text-neutral-500" />
      {domaine(`categoriesNouveaute.${category}`)}
    </span>
  );
}
