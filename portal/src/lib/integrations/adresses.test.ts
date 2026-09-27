import { describe, expect, test } from "vitest";
import { adresseAutorisee } from "./adresses";

/* Adresse de l'appelant d'une intégration (spécification #71) : comprise dans ses adresses et plages CIDR, ou refusée. */
describe("adresse de l'appelant", () => {
  const plages = ["203.0.113.10", "198.51.100.0/24", "2001:db8::/32"];

  test("une adresse de la liste, ou d'une de ses plages, est autorisée ; une adresse IPv4 écrite en IPv6 aussi", () => {
    for (const adresse of ["203.0.113.10", "198.51.100.1", "198.51.100.254", "2001:db8::1", "2001:db8:ffff::42", "::ffff:203.0.113.10"]) {
      expect(adresseAutorisee(adresse, plages), adresse).toBe(true);
    }
  });

  test("une autre adresse, une adresse absente ou illisible, ou une liste vide, est refusée", () => {
    for (const adresse of ["203.0.113.11", "198.51.101.1", "2001:db9::1", "127.0.0.1", "", "exemple.org", "203.0.113.10, 127.0.0.1"]) {
      expect(adresseAutorisee(adresse, plages), adresse).toBe(false);
    }
    expect(adresseAutorisee(null, plages)).toBe(false);
    expect(adresseAutorisee("203.0.113.10", [])).toBe(false);
  });
});
