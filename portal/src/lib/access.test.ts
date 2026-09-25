import { describe, expect, test } from "vitest";
import { decideServiceAccess } from "./access";

const portalOrigin = "https://ai-gateway.linagora.com";

describe("point de contrôle de /admin et /stats", () => {
  test("sans session, renvoie vers la connexion du portail puis vers l'adresse demandée", () => {
    expect(decideServiceAccess(null, "admin", { portalOrigin, originalUri: "/admin/ui/?page=models", reportingUidsSetting: "" })).toEqual({
      kind: "login",
      location: "https://ai-gateway.linagora.com/api/auth/signin?callbackUrl=https%3A%2F%2Fai-gateway.linagora.com%2Fadmin%2Fui%2F%3Fpage%3Dmodels",
    });
  });

  test("une adresse de retour qui n'est pas un chemin local est remplacée par l'accueil (pas de redirection ouverte)", () => {
    for (const originalUri of ["@evil.example/x", "//evil.example/x", "https://evil.example/"]) {
      expect(decideServiceAccess(null, "stats", { portalOrigin, originalUri, reportingUidsSetting: "" })).toEqual({
        kind: "login",
        location: "https://ai-gateway.linagora.com/api/auth/signin?callbackUrl=https%3A%2F%2Fai-gateway.linagora.com%2F",
      });
    }
  });

  const ctx = { portalOrigin, originalUri: "/", reportingUidsSetting: "hlefevre, pmartin" };
  const admin = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: true };
  const salarie = { uid: "jdurand", email: "jdurand@linagora.com", name: "Jean Durand", isAdmin: false };
  const lectrice = { uid: "hlefevre", email: "hlefevre@linagora.com", name: "Hélène Lefèvre", isAdmin: false };

  test("un admin accède à la console LiteLLM, son identité étant transmise à l'application", () => {
    expect(decideServiceAccess(admin, "admin", ctx)).toEqual({
      kind: "allow",
      headers: { "X-Portal-User": "mmaudet", "X-Portal-Role": "admin", "X-Portal-Email": "mmaudet@linagora.com", "X-Portal-Name": "Michel-Marie%20Maudet" },
    });
  });

  test("un salarié qui n'est pas admin est refusé sur la console LiteLLM", () => {
    expect(decideServiceAccess(salarie, "admin", ctx)).toEqual({ kind: "deny" });
  });

  test("une lectrice du reporting ne passe pas pour autant sur la console LiteLLM", () => {
    expect(decideServiceAccess(lectrice, "admin", ctx)).toEqual({ kind: "deny" });
  });

  test("une lectrice listée dans PORTAL_REPORTING_UIDS accède à Superset en lecture", () => {
    expect(decideServiceAccess(lectrice, "stats", ctx)).toEqual({
      kind: "allow",
      headers: { "X-Portal-User": "hlefevre", "X-Portal-Role": "reader", "X-Portal-Email": "hlefevre@linagora.com", "X-Portal-Name": "H%C3%A9l%C3%A8ne%20Lef%C3%A8vre" },
    });
  });

  test("un admin accède à Superset en tant qu'admin", () => {
    expect(decideServiceAccess(admin, "stats", ctx)).toMatchObject({ kind: "allow", headers: { "X-Portal-Role": "admin" } });
  });

  test("un salarié hors des listes est refusé sur Superset", () => {
    expect(decideServiceAccess(salarie, "stats", ctx)).toEqual({ kind: "deny" });
  });
});
