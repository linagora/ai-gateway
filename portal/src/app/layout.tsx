import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { getCurrentUser } from "@/lib/session";
import { SelecteurLangue, UserMenu } from "./components";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadonnees");
  return { title: t("titre"), description: t("description") };
}

// Interface minimale (V1) : l'ergonomie et le graphisme seront repris dans un second temps.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [locale, t, user] = await Promise.all([getLocale(), getTranslations("entete"), getCurrentUser()]);
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <header className="flex flex-wrap items-center gap-4 border-t-4 border-b border-t-linagora px-6 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold text-neutral-900 no-underline">
              <Image src="/linagora-logo.svg" alt="Linagora" width={116} height={24} priority />
              {t("portail")}
            </Link>
            {user && (
              <nav className="flex flex-wrap gap-x-4" aria-label={t("navigation")}>
                <Link href="/catalogue">{t("catalogue")}</Link>
                <Link href="/demandes">{t("mesDemandes")}</Link>
                <Link href="/demandes/nouvelle">{t("nouvelleDemande")}</Link>
              </nav>
            )}
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
