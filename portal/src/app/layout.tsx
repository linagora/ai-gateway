import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { UserMenu } from "./components";
import "./globals.css";

export const metadata: Metadata = {
  title: "Portail IA Linagora",
  description: "Catalogue des modèles d'IA et demandes de clés d'API",
};

// Interface minimale (V1) : l'ergonomie et le graphisme seront repris dans un second temps.
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr">
      <body>
        <header className="flex flex-wrap items-center gap-4 border-b px-6 py-3">
          <Link href="/" className="font-semibold">
            Portail IA Linagora
          </Link>
          <nav className="flex gap-4">
            <Link href="/catalogue">Catalogue</Link>
            <Link href="/demandes">Mes demandes</Link>
            <Link href="/demandes/nouvelle">Nouvelle demande</Link>
          </nav>
          <Suspense fallback={null}>
            <UserMenu />
          </Suspense>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
      </body>
    </html>
  );
}
