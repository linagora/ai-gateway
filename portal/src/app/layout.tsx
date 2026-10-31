import type { Metadata } from "next";
import localFont from "next/font/local";
import Image from "next/image";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { countMyPending } from "@/lib/services/requests";
import { getCurrentUser, getDeps } from "@/lib/session";
import paquet from "../../package.json";
import { SelecteurLangue, UserMenu } from "./components";
import { Onglets } from "./onglets";
import { Pastille } from "./pastille";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadonnees");
  return { title: t("titre"), description: t("description") };
}

/*
 * Police du portail : Inter 4.1 (licence OFL, polices/LICENSE.txt), variable, réduite aux alphabets latins par pyftsubset
 * (fontTools). Embarquée, elle donne le même rendu sur tous les postes, Linux compris (ticket #155).
 */
const inter = localFont({
  src: [
    { path: "./polices/InterVariable.woff2", weight: "100 900", style: "normal" },
    { path: "./polices/InterVariable-Italic.woff2", weight: "100 900", style: "italic" },
  ],
  variable: "--police-inter",
});

// Interface minimale (V1) : l'ergonomie et le graphisme seront repris dans un second temps.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [locale, t, pied, user] = await Promise.all([getLocale(), getTranslations("entete"), getTranslations("pied"), getCurrentUser()]);
  // Pastilles : ce que le salarié peut faire maintenant (clé approuvée à retirer, demande à compléter).
  const enAttente = user ? await countMyPending(getDeps(), user) : null;
  return (
    <html lang={locale} className={inter.variable}>
      <body>
        <NextIntlClientProvider>
          <header className="flex flex-wrap items-center gap-4 border-t-4 border-b border-t-linagora px-6 py-3 print:hidden">
            <Link href="/" className="flex items-center gap-2 font-semibold text-neutral-900 no-underline">
              {/* Logo de référence : Linagora-logo.png de Wikimedia Commons (656 × 138), servi tel quel. */}
              <Image src="/linagora-logo.png" alt="LINAGORA" width={114} height={24} loading="eager" unoptimized />
              {t("portail")}
            </Link>
            {user && (
              <nav className="flex flex-wrap gap-x-4" aria-label={t("navigation")}>
                <Onglets
                  onglets={[
                    { href: "/catalogue", contenu: t("catalogue") },
                    {
                      href: "/demandes",
                      contenu: (
                        <>
                          {t("mesDemandes")}
                          <Pastille nombre={enAttente?.demandesACompleter ?? 0} libelle={t("aCompleter", { nombre: enAttente?.demandesACompleter ?? 0 })} />
                        </>
                      ),
                    },
                    {
                      href: "/cles",
                      contenu: (
                        <>
                          {t("mesCles")}
                          <Pastille nombre={enAttente?.clesARetirer ?? 0} libelle={t("aRetirer", { nombre: enAttente?.clesARetirer ?? 0 })} />
                        </>
                      ),
                    },
                    {
                      href: "/abonnements",
                      contenu: (
                        <>
                          {t("mesAbonnements")}
                          <Pastille nombre={enAttente?.abonnementsADeclarer ?? 0} libelle={t("aDeclarer", { nombre: enAttente?.abonnementsADeclarer ?? 0 })} />
                        </>
                      ),
                    },
                    // Les formulaires de demande (clé, abonnement, adhésion à une équipe) relèvent tous de cet onglet.
                    { href: "/demandes/nouvelle", contenu: t("nouvelleDemande"), sections: ["/demandes/nouvelle", "/demandes/abonnement", "/demandes/adhesion"] },
                    { href: "/etat", contenu: t("etat") },
                    { href: "/documentation/api", contenu: t("api"), sections: ["/documentation"] },
                  ]}
                />
              </nav>
            )}
            <Suspense fallback={null}>
              <UserMenu />
            </Suspense>
            <SelecteurLangue />
          </header>
          <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
          {/* Version publiée du projet (SemVer, celle de package.json) et ses notes, montrées aux seules personnes connectées. */}
          {user && (
            <footer className="mx-auto max-w-6xl px-6 pb-6 text-sm print:hidden">
              <a href={`https://github.com/linagora/ai-gateway/releases/tag/v${paquet.version}`} className="text-neutral-500">
                {pied("version", { version: paquet.version })}
                <span className="sr-only"> ({pied("notes")})</span>
              </a>
            </footer>
          )}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
