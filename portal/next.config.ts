import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  // Image Docker minimale (brief §1) : .next/standalone + public + .next/static.
  output: "standalone",
  poweredByHeader: false,
  // Le guide d'intégration, lu par sa page au moment de la requête, part avec elle dans la sortie standalone.
  outputFileTracingIncludes: { "/documentation/api/guide": ["./docs/INTEGRATIONS.md", "./docs/INTEGRATIONS.en.md"] },
  async headers() {
    // HSTS, nosniff et Referrer-Policy sont posés par Caddy. La CSP stricte (nonces) viendra avec la
    // reprise de l'interface ; en attendant, interdiction d'afficher le portail dans un cadre.
    return [
      { source: "/:path*", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] },
      // API d'intégration : aucune réponse mise en cache, y compris celles de Next.js (405 d'une méthode non prévue).
      { source: "/api/v1/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};

// Textes du portail en français et en anglais : configuration par requête dans src/i18n/request.ts.
export default createNextIntlPlugin()(nextConfig);
