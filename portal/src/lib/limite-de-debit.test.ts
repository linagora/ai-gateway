import { describe, expect, test } from "vitest";
import { LimiteDeDebit } from "./limite-de-debit";

/* Limite de fréquence en fenêtre glissante : par clé, un maximum par défaut ou propre à l'appel, et l'attente avant une place libre. */
describe("limite de débit", () => {
  const a = (secondes: number) => new Date(Date.UTC(2026, 8, 28, 10, 0, secondes));

  test("au plus le maximum d'événements par fenêtre glissante ; une place se libère quand le plus ancien sort de la fenêtre", () => {
    const limite = new LimiteDeDebit(2, 60_000);
    expect([limite.autoriser("demo", a(0)), limite.autoriser("demo", a(10)), limite.autoriser("demo", a(20))]).toEqual([true, true, false]);
    expect(limite.attente("demo", a(20))).toBe(40_000);
    expect(limite.autoriser("autre", a(20))).toBe(true);
    expect(limite.autoriser("demo", a(60))).toBe(true);
    expect(limite.attente("autre", a(20))).toBe(0);
  });

  test("un maximum propre à l'appel remplace le maximum par défaut (plafond de chaque intégration)", () => {
    const limite = new LimiteDeDebit(120, 60_000);
    expect([1, 2, 3, 4].map((s) => limite.autoriser("team-manager", a(s), 3))).toEqual([true, true, true, false]);
    expect(limite.attente("team-manager", a(4), 3)).toBe(57_000);
  });
});
