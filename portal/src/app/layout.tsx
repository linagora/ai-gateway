import type { Metadata } from "next";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { SelecteurLangue, UserMenu } from "./components";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadonnees");
  return { title: t("titre"), description: t("description") };
}

// Interface minimale (V1) : l'ergonomie et le graphisme seront repris dans un second temps.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [locale, t] = await Promise.all([getLocale(), getTranslations("entete")]);
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <header className="flex flex-wrap items-center gap-4 border-b px-6 py-3">
            <Link href="/" className="font-semibold">
              {t("portail")}
            </Link>
            <nav className="flex gap-4" aria-label={t("navigation")}>
              <Link href="/catalogue">{t("catalogue")}</Link>
              <Link href="/demandes">{t("mesDemandes")}</Link>
              <Link href="/demandes/nouvelle">{t("nouvelleDemande")}</Link>
            </nav>
            <Suspense fallback={null}>
              <UserMenu />
            </Suspense>
            <SelecteurLangue />
          </header>
          <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
