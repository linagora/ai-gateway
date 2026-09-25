import type { DefaultSession } from "next-auth";
import type { JWT } from "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    user: { uid: string } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  // L'import de JWT ci-dessus est nécessaire : sans lui, cette augmentation est ignorée.
  interface JWT {
    uid?: string;
    loginAt?: number;
  }
}

export type { JWT };
