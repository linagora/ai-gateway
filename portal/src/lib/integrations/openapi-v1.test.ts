import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, test } from "vitest";
import contrat from "./openapi-v1.json";

/*
 * Contrat de l'API d'intégration (spécification #71, ticket #72) : valide, et conforme aux décisions de la
 * spécification (routes, périmètres, livraisons, jeton, erreurs, engagement).
 */
type Operation = { "x-scope": string | null; "x-delivery": number; "x-status": string; responses: Record<string, unknown> };
const operations = Object.entries(contrat.paths).flatMap(([chemin, methodes]) =>
  Object.entries(methodes as Record<string, Operation>).map(([methode, op]) => ({ route: `${methode.toUpperCase()} ${chemin}`, ...op })),
);

describe("contrat OpenAPI de l'API d'intégration", () => {
  test("est un document OpenAPI 3.1 valide", async () => {
    const resultat = await new Validator().validate(structuredClone(contrat));
    expect(resultat.errors ?? []).toEqual([]);
    expect(resultat.valid).toBe(true);
    expect(contrat.openapi).toBe("3.1.0");
  });

  test("chaque route déclare son périmètre et sa livraison ; celles de la seconde livraison sont marquées à venir", () => {
    expect(operations.map((o) => [o.route, o["x-scope"], o["x-delivery"], o["x-status"]])).toEqual([
      ["GET /openapi.json", null, 1, "available"],
      ["GET /me/teams", "lecture", 1, "available"],
      ["GET /teams/joinable", "lecture", 1, "available"],
      ["GET /catalog", "lecture", 1, "available"],
      ["GET /requests", "lecture", 1, "available"],
      ["GET /keys", "lecture", 1, "available"],
      ["POST /team-access-requests", "demandes", 1, "available"],
      ["POST /key-requests", "demandes", 1, "available"],
      ["PUT /key-requests/{id}", "demandes", 1, "available"],
      ["POST /requests/{id}/cancel", "demandes", 1, "available"],
      ["POST /key-requests/{id}/pickup", "cles", 2, "planned"],
      ["POST /keys/{id}/replace", "cles", 2, "planned"],
      ["POST /keys/{id}/revoke", "cles", 2, "planned"],
      ["GET /keys/{id}/renewal-draft", "cles", 2, "planned"],
    ]);
  });

  test("toute route exige le jeton d'intégration et prévoit les refus communs : jeton, périmètre ou adresse, plafond, intégration inactive", () => {
    expect(contrat.security).toEqual([{ integrationToken: [] }]);
    expect(contrat.components.securitySchemes.integrationToken).toMatchObject({ type: "http", scheme: "bearer", bearerFormat: "JWT" });
    for (const o of operations) expect(Object.keys(o.responses), o.route).toEqual(expect.arrayContaining(["401", "403", "429", "503"]));
    for (const champ of ["`kid`", "`iss`", "`aud`", "`sub`", "`email`", "`name`", "`iat`", "`exp`", "300 seconds", "EdDSA", "RS256"]) {
      expect(contrat.components.securitySchemes.integrationToken.description).toContain(champ);
    }
  });

  test("les erreurs ont une forme unique et des codes stables, existants et nouveaux", () => {
    expect(contrat.components.schemas.Error.properties.error.required).toEqual(["code", "message", "details"]);
    expect(contrat.components.schemas.ErrorCode.enum).toEqual(
      expect.arrayContaining([
        "saisie_invalide", "engagement_requis", "controles_en_echec", "jeton_invalide", "hors_perimetre", "adresse_non_autorisee", "introuvable",
        "transition_interdite", "demande_en_cours", "identite_incoherente", "trop_de_requetes", "trop_de_generations", "passerelle_indisponible",
        "integration_inactive",
      ]),
    );
    expect(Object.keys(contrat.components.responses).sort()).toEqual(
      ["BadGateway", "BadRequest", "Conflict", "Forbidden", "NotFound", "ServiceUnavailable", "TooManyRequests", "Unauthorized"],
    );
  });

  test("la demande de clé exige l'engagement dont le catalogue donne le texte exact", () => {
    const { KeyRequestInput, KeyRequestCompletion, Catalog } = contrat.components.schemas;
    for (const schema of [KeyRequestInput, KeyRequestCompletion]) {
      expect(schema.required).toContain("commitment");
      expect(schema.properties.commitment).toMatchObject({ type: "boolean", const: true });
      expect(schema.additionalProperties).toBe(false);
    }
    expect(KeyRequestInput.properties).toHaveProperty("renewsRequestId");
    expect(Catalog.required).toContain("commitment");
  });
});
