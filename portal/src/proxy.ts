// Vérification optimiste de la session (cookie seulement). Le contrôle qui fait foi est rejoué dans
// chaque page et chaque Server Action (src/lib/session.ts). /api/acces (point de contrôle appelé par
// Caddy) gère lui-même l'absence de session, pour renvoyer vers l'adresse demandée à l'origine.
export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|api/acces|_next/static|_next/image|favicon.ico).*)"],
};
