import { describe, expect, test } from "vitest";
import { etatApresSonde, type EtatModele, lireIntervalle, SEUIL_ALERTE } from "./supervision";

const repond = { status: 200, latencyMs: 120, error: null };
const echoue = { status: 502, latencyMs: 40, error: "Provider returned error" };
const t = (minutes: number) => new Date(Date.UTC(2026, 9, 7, 10, minutes));

/** Enchaîne les sondes à 5 minutes d'intervalle ; rend l'état final et les alertes de chaque sonde. */
function enchainer(sondes: (typeof repond | typeof echoue)[], depart: EtatModele | null = null) {
  let etat = depart;
  const alertes = sondes.map((sonde, i) => {
    const suite = etatApresSonde(etat, sonde, t(i * 5));
    etat = suite.etat;
    return suite.alerte;
  });
  return { etat: etat as unknown as EtatModele, alertes };
}

describe("supervision : état d'un modèle après une sonde", () => {
  test("un modèle qui répond est sain depuis sa première sonde, sans alerte", () => {
    const { etat, alertes } = enchainer([repond, repond]);
    expect(alertes).toEqual([null, null]);
    expect(etat).toMatchObject({ healthy: true, since: t(0), checkedAt: t(5), failures: 0, alertedAt: null, latencyMs: 120, error: null });
  });

  test(`un échec isolé n'alerte personne ; ${SEUIL_ALERTE} échecs consécutifs alertent une seule fois, depuis le premier échec`, () => {
    expect(enchainer([repond, echoue, repond]).alertes).toEqual([null, null, null]);

    const { etat, alertes } = enchainer([repond, echoue, echoue, echoue]);
    expect(alertes).toEqual([null, null, "panne", null]);
    expect(etat).toMatchObject({ healthy: false, since: t(5), failures: 3, alertedAt: t(10), httpStatus: 502, error: "Provider returned error" });
  });

  test("le rétablissement n'est annoncé que pour une panne annoncée, et remet le compte à zéro", () => {
    const { etat, alertes } = enchainer([echoue, echoue, repond, echoue]);
    expect(alertes).toEqual([null, "panne", "retablissement", null]);
    expect(etat).toMatchObject({ healthy: false, since: t(15), failures: 1, alertedAt: null });
  });
});

describe("supervision : intervalle de SUPERVISION_INTERVAL_MINUTES", () => {
  test("un nombre entier de minutes, d'une minute à un jour ; absent, 0 ou hors de ces bornes, la sonde automatique est désactivée", () => {
    expect(lireIntervalle("5")).toBe(5);
    expect(lireIntervalle("7")).toBe(7);
    expect(lireIntervalle("1440")).toBe(1440);
    for (const valeur of [undefined, "", "0", "-5", "1441", "5.5", "abc"]) expect(lireIntervalle(valeur)).toBeNull();
  });
});
