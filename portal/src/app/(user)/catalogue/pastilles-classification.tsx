import Image from "next/image";
import { getTranslations } from "next-intl/server";
import type { DataLevel } from "@/lib/policy";

/** Classification des informations de LINAGORA : NC (public), C1 (interne), C2 (restreint), C3 (secret). */
type Classification = "NC" | "C1" | "C2" | "C3";

/**
 * Classifications que chaque niveau accepte (décision du 2026-09-26), montrées par les pastilles fournies par LINAGORA,
 * servies telles quelles (public/classification, 880 × 168, nettes sur un écran haute densité). Le niveau Expérimental,
 * réservé aux données publiques, n'accepte que NC.
 */
const CLASSIFICATIONS: Record<DataLevel, readonly Classification[]> = { N1: ["NC", "C1"], N2: ["C2"], N3: ["C3"], EXP: ["NC"] };

/** Pastilles des classifications qu'un niveau accepte, chacune nommée pour les lecteurs d'écran ; `className` les dispose. */
export async function PastillesClassification({ level, className }: { level: DataLevel; className: string }) {
  const domaine = await getTranslations("domaine");
  return (
    <div className={className}>
      {CLASSIFICATIONS[level].map((classification) => (
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
