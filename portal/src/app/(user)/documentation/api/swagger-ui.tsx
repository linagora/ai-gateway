"use client";

import { useEffect, useRef } from "react";
import "swagger-ui-dist/swagger-ui.css";

/**
 * Swagger UI, hébergé par le portail, chargé sur cette seule page. Le serveur du contrat est celui de la page : les essais
 * visent la même origine que l'API, avec ses contrôles. Aucun validateur en ligne, et le jeton n'est pas gardé.
 */
export function SwaggerUi({ contrat }: { contrat: Record<string, unknown> }) {
  const conteneur = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let affiche = true;
    void import("swagger-ui-dist/swagger-ui-es-bundle.js").then(({ default: SwaggerUIBundle }) => {
      if (!affiche || !conteneur.current) return;
      SwaggerUIBundle({
        domNode: conteneur.current,
        spec: { ...contrat, servers: [{ url: `${window.location.origin}/api/v1` }] },
        validatorUrl: null,
        persistAuthorization: false,
        deepLinking: false,
        displayRequestDuration: true,
        docExpansion: "list",
        defaultModelsExpandDepth: 0,
      });
    });
    return () => {
      affiche = false;
    };
  }, [contrat]);
  return <div ref={conteneur} className="mt-6" />;
}
