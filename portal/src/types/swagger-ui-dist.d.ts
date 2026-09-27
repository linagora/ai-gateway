/** Swagger UI (swagger-ui-dist, sans types publiés) : la fonction qui rend un contrat OpenAPI dans un élément de la page. */
declare module "swagger-ui-dist/swagger-ui-es-bundle.js" {
  const SwaggerUIBundle: (options: Record<string, unknown>) => unknown;
  export default SwaggerUIBundle;
}
