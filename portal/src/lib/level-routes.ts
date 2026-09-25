import { DATA_LEVELS, type DataLevel } from "@/lib/policy";

/** Adresse de la page d'un niveau de confidentialité dans le catalogue. */
const SEGMENTS: Record<DataLevel, string> = { N1: "n1", N2: "n2", N3: "n3", EXP: "experimental" };

export function levelSegment(level: DataLevel): string {
  return SEGMENTS[level];
}

export function levelFromSegment(segment: string): DataLevel | null {
  return DATA_LEVELS.find((level) => SEGMENTS[level] === segment) ?? null;
}
