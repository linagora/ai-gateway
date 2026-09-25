import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  // Image Docker minimale (brief §1) : .next/standalone + public + .next/static.
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    // HSTS, nosniff et Referrer-Policy sont posés par Caddy. La CSP stricte (nonces) viendra avec la
    // reprise de l'interface ; en attendant, interdiction d'afficher le portail dans un cadre.
    return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] }];
  },
};

// Textes du portail en français et en anglais : configuration par requête dans src/i18n/request.ts.
export default createNextIntlPlugin()(nextConfig);
