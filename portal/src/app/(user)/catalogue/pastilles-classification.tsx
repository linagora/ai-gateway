import Image from "next/image";
import { getTranslations } from "next-intl/server";
import { CLASSIFICATIONS_ACCEPTEES, type DataLevel } from "@/lib/policy";

/**
 * Pastilles des classifications qu'un niveau accepte, fournies par LINAGORA et servies telles quelles
 * (public/classification, 880 × 168, nettes sur un écran haute densité), chacune nommée pour les lecteurs d'écran ;
 * `className` les dispose.
 */
export async function PastillesClassification({ level, className }: { level: DataLevel; className: string }) {
  const domaine = await getTranslations("domaine");
  return (
    <div className={className}>
      {CLASSIFICATIONS_ACCEPTEES[level].map((classification) => (
        <Image
          key={classification}
          src={`/classification/${classification}.png`}
          alt={domaine(`classifications.${classification}`)}
          width={168}
          height={32}
          unoptimized
        />
      ))}
    </div>
  );
}
