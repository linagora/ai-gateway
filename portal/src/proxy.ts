// Vérification optimiste de la session (cookie seulement). Le contrôle qui fait foi est rejoué dans
// chaque page et chaque Server Action (src/lib/session.ts). /api/acces (point de contrôle appelé par
// Caddy) gère lui-même l'absence de session, pour renvoyer vers l'adresse demandée à l'origine.
export { auth as proxy } from "@/auth";

export const config = {
  // Images publiques (logo) servies sans session : la page de connexion les affiche.
  // /api/taches (tâche quotidienne) s'authentifie par son jeton, sans session.
  matcher: ["/((?!api/auth|api/acces|api/taches|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg)$).*)"],
};
