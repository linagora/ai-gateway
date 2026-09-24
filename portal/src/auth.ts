import NextAuth from "next-auth";
import type { OIDCConfig } from "next-auth/providers";
import { toPortalUser } from "@/lib/auth-user";
import { getLiteLLM } from "@/lib/litellm/instance";
import { provisionUser } from "@/lib/services/provisioning";

/** F-01 : connexion OIDC (Authorization Code + PKCE) sur le SSO LemonLDAP::NG, et aucune autre. */
const lemonldap: OIDCConfig<Record<string, unknown>> = {
  id: "lemonldap",
  name: "LemonLDAP::NG",
  type: "oidc",
  issuer: process.env.OIDC_ISSUER,
  clientId: process.env.OIDC_CLIENT_ID,
  clientSecret: process.env.OIDC_CLIENT_SECRET,
  checks: ["pkce", "state"],
  authorization: { params: { scope: "openid profile email" } },
};

const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

// Même domaine que Superset et l'UI LiteLLM : cookies propres au portail (préfixe « portal. »).
// Les préfixes __Secure- / __Host- n'ont de sens qu'en HTTPS.
const secure = (process.env.AUTH_URL ?? "").startsWith("https://");
const cookiePrefix = secure ? "__Secure-" : "";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [lemonldap],
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  useSecureCookies: secure,
  cookies: {
    sessionToken: { name: `${cookiePrefix}portal.session-token` },
    callbackUrl: { name: `${cookiePrefix}portal.callback-url` },
    csrfToken: { name: `${secure ? "__Host-" : ""}portal.csrf-token` },
    pkceCodeVerifier: { name: `${cookiePrefix}portal.pkce-code-verifier` },
    state: { name: `${cookiePrefix}portal.state` },
    nonce: { name: `${cookiePrefix}portal.nonce` },
  },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account?.provider === "lemonldap" && profile) {
        // Sans adaptateur de base, token.sub serait un UUID aléatoire : on reprend le sub OIDC (= uid LDAP).
        const user = toPortalUser(
          { sub: typeof profile.sub === "string" ? profile.sub : null, email: profile.email as string | undefined, name: profile.name as string | undefined },
          process.env.PORTAL_ADMIN_UIDS,
        );
        if (!user) return null;
        await provisionUser({ litellm: getLiteLLM() }, user);
        return { sub: user.uid, uid: user.uid, email: user.email, name: user.name, loginAt: Date.now() };
      }
      // Durée de session absolue de 8 h, même si le cookie est renouvelé par l'activité.
      if (typeof token.loginAt !== "number" || Date.now() - token.loginAt > SESSION_MAX_AGE_SECONDS * 1000) return null;
      return token;
    },
    session({ session, token }) {
      session.user.uid = typeof token.uid === "string" ? token.uid : "";
      return session;
    },
    authorized: ({ auth: session }) => Boolean(session?.user?.uid),
  },
});
