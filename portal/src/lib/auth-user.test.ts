import { describe, expect, test } from "vitest";
import { toPortalUser } from "./auth-user";

describe("toPortalUser", () => {
  test("les claims OIDC d'un admin donnent un utilisateur admin, identifié par son uid", () => {
    const claims = { sub: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet" };
    expect(toPortalUser(claims, "mmaudet")).toEqual({ uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: true });
  });

  test("la liste des admins tolère espaces et virgules superflues", () => {
    const claims = { sub: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont" };
    expect(toPortalUser(claims, " mmaudet , jdupont,,")?.isAdmin).toBe(true);
  });

  test("un salarié hors de la liste n'est pas admin", () => {
    const claims = { sub: "pmartin", email: "pmartin@linagora.com", name: "Paul Martin" };
    expect(toPortalUser(claims, "mmaudet")?.isAdmin).toBe(false);
  });

  test("sans liste d'admins configurée, personne n'est admin", () => {
    const claims = { sub: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet" };
    expect(toPortalUser(claims, undefined)?.isAdmin).toBe(false);
  });

  test("un profil sans uid est refusé", () => {
    expect(toPortalUser({ email: "anonyme@linagora.com", name: "Anonyme" }, "mmaudet")).toBeNull();
  });

  test("un profil sans e-mail est refusé", () => {
    expect(toPortalUser({ sub: "mmaudet", name: "Michel-Marie Maudet" }, "mmaudet")).toBeNull();
  });
});
