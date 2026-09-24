// Vérification optimiste de la session (cookie seulement). Le contrôle qui fait foi est rejoué dans
// chaque page et chaque Server Action (src/lib/session.ts).
export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
