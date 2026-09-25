import { CAPABILITIES } from "@/lib/litellm/client";
import { DATA_LEVELS, type DataLevel } from "@/lib/policy";
import { LEVEL_SORTS, type LevelCriteria, type LevelSort } from "@/lib/services/catalog";
import { USE_CASES } from "@/lib/use-cases";

/** Adresse de la page d'un niveau de confidentialité dans le catalogue. */
const SEGMENTS: Record<DataLevel, string> = { N1: "n1", N2: "n2", N3: "n3", EXP: "experimental" };

export function levelSegment(level: DataLevel): string {
  return SEGMENTS[level];
}

export function levelFromSegment(segment: string): DataLevel | null {
  return DATA_LEVELS.find((level) => SEGMENTS[level] === segment) ?? null;
}

/** Valeurs du paramètre « tri » dans l'adresse de la page d'un niveau. */
const TRIS: Record<LevelSort, string> = { recommended: "recommandes", price: "prix", context: "contexte", name: "nom" };

export function sortParam(sort: LevelSort): string {
  return TRIS[sort];
}

/**
 * Critères de la page d'un niveau lus dans son adresse, pour qu'une recherche puisse être partagée :
 * ?q=<texte>&cas=<cas d'usage>&capacite=<capacité>…&ue=1&tri=<tri>. Une valeur inconnue est ignorée.
 */
export function levelCriteria(searchParams: Record<string, string | string[] | undefined>): LevelCriteria {
  const valeurs = (nom: string) => [searchParams[nom]].flat().filter((v): v is string => typeof v === "string");
  const premiere = (nom: string) => valeurs(nom)[0] ?? "";
  return {
    search: premiere("q"),
    useCase: USE_CASES.find((u) => u === premiere("cas")),
    capabilities: CAPABILITIES.filter((c) => valeurs("capacite").includes(c)),
    euOnly: premiere("ue") === "1",
    sort: LEVEL_SORTS.find((s) => TRIS[s] === premiere("tri")) ?? "recommended",
  };
}
