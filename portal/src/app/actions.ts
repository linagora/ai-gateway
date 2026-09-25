"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn, signOut } from "@/auth";
import { PolicyViolationError, PortalError } from "@/lib/errors";
import { COOKIE_LANGUE, LANGUES, type Langue } from "@/lib/langue";
import type { DataLevel } from "@/lib/policy";
import type { UseCase } from "@/lib/use-cases";
import {
  approveKeyRequest,
  approveTeamJoinRequest,
  refuseRequest,
  requestCompletion,
} from "@/lib/services/admin-requests";
import { saveCatalogEntry } from "@/lib/services/catalog";
import { cancelRequest, completeRequest, createKeyRequest, createTeamJoinRequest } from "@/lib/services/requests";
import { saveSettings } from "@/lib/services/settings";
import { getDeps, requireUser } from "@/lib/session";

/*
 * Server Actions : chaque action est un point d'entrée non fiable (doc Next.js 16). Elle identifie
 * l'utilisateur, puis délègue au cas d'usage qui rejoue les contrôles d'autorisation et de politique.
 */

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/" });
}

/**
 * F-01 : connexion par le SSO, puis retour à l'adresse demandée (Auth.js n'accepte que l'origine du portail).
 * Action publique par nature : elle ne fait que lancer l'authentification.
 */
export async function connexionAction(formData: FormData): Promise<void> {
  const retour = formData.get("callbackUrl");
  await signIn("lemonldap", { redirectTo: typeof retour === "string" && retour ? retour : "/" });
}

/**
 * Sélecteur FR | EN : mémorise la langue choisie ; Next.js réaffiche alors la page courante.
 * Action publique (la page de connexion propose aussi le sélecteur) : elle ne touche qu'à un cookie de préférence.
 */
export async function changerLangueAction(formData: FormData): Promise<void> {
  const langue = formData.get("langue");
  if (!(LANGUES as readonly unknown[]).includes(langue)) return;
  (await cookies()).set(COOKIE_LANGUE, langue as Langue, {
    path: "/",
    maxAge: 365 * 24 * 60 * 60,
    sameSite: "lax",
    httpOnly: true,
    secure: (process.env.AUTH_URL ?? "").startsWith("https://"),
  });
}

export async function createKeyRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const completing = text(formData, "requestId");
  await run(
    "/demandes/nouvelle",
    async () => {
      const input = keyRequestFromForm(formData);
      if (completing) await completeRequest(getDeps(), user, completing, input);
      else await createKeyRequest(getDeps(), user, input);
    },
    { path: "/demandes", message: completing ? "demandeResoumise" : "demandeEnvoyee" },
  );
}

export async function createTeamJoinRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run(
    "/demandes/adhesion",
    () => createTeamJoinRequest(getDeps(), user, { teamId: text(formData, "teamId"), justification: text(formData, "justification") }),
    { path: "/demandes", message: "adhesionEnvoyee" },
  );
}

export async function cancelRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run("/demandes", () => cancelRequest(getDeps(), user, text(formData, "id")), { path: "/demandes", message: "demandeAnnulee" });
}

export async function saveCatalogEntryAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run(
    "/gestion/catalogue",
    () =>
      saveCatalogEntry(getDeps(), user, {
        modelName: text(formData, "modelName"),
        displayNameFr: text(formData, "displayNameFr"),
        displayNameEn: optionalText(formData, "displayNameEn"),
        shortDescriptionFr: text(formData, "shortDescriptionFr"),
        shortDescriptionEn: optionalText(formData, "shortDescriptionEn"),
        longDescriptionFr: text(formData, "longDescriptionFr"),
        longDescriptionEn: optionalText(formData, "longDescriptionEn"),
        limitationsFr: optionalText(formData, "limitationsFr"),
        limitationsEn: optionalText(formData, "limitationsEn"),
        // Valeurs contrôlées par le service (liste fermée des cas d'usage).
        useCases: formData.getAll("useCases").map(String) as UseCase[],
        recommendedFor: formData.getAll("recommendedFor").map(String) as UseCase[],
        dataLevel: text(formData, "dataLevel") as DataLevel,
        visible: formData.get("visible") === "on",
      }),
    { path: "/gestion/catalogue", message: "catalogueMisAJour" },
  );
}

export async function approveKeyRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(formData, "id");
  await run(
    `/gestion/demandes/${id}`,
    () =>
      approveKeyRequest(getDeps(), user, id, {
        teamId: optionalText(formData, "teamId") ?? undefined,
        models: formData.getAll("models").map(String),
        budget: optionalNumber(formData, "budget"),
        budgetDuration: optionalText(formData, "budgetDuration"),
        days: optionalNumber(formData, "days"),
        rpmLimit: optionalNumber(formData, "rpmLimit"),
        tpmLimit: optionalNumber(formData, "tpmLimit"),
      }),
    { path: "/gestion/demandes", message: "demandeApprouvee" },
  );
}

export async function approveTeamJoinRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(formData, "id");
  await run(`/gestion/demandes/${id}`, () => approveTeamJoinRequest(getDeps(), user, id, optionalText(formData, "teamId") ?? undefined), {
    path: "/gestion/demandes",
    message: "adhesionApprouvee",
  });
}

export async function refuseRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(formData, "id");
  await run(`/gestion/demandes/${id}`, () => refuseRequest(getDeps(), user, id, text(formData, "comment")), {
    path: "/gestion/demandes",
    message: "demandeRefusee",
  });
}

export async function requestCompletionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(formData, "id");
  await run(`/gestion/demandes/${id}`, () => requestCompletion(getDeps(), user, id, text(formData, "comment")), {
    path: "/gestion/demandes",
    message: "complementDemande",
  });
}

export async function saveSettingsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const keys = ["default_budget", "default_budget_duration", "default_days", "default_rpm", "default_tpm", "pickup_days"] as const;
  const values = Object.fromEntries(keys.flatMap((k) => (optionalText(formData, k) ? [[k, optionalText(formData, k)]] : [])));
  await run("/gestion/parametres", () => saveSettings(getDeps(), user, values), { path: "/gestion/parametres", message: "parametresEnregistres" });
}

// --- outils ---

/** Clés des messages de succès, traduites par l'avis (dictionnaires, espace « avis.succes »). */
type CleSucces =
  | "demandeEnvoyee"
  | "demandeResoumise"
  | "adhesionEnvoyee"
  | "demandeAnnulee"
  | "catalogueMisAJour"
  | "demandeApprouvee"
  | "adhesionApprouvee"
  | "demandeRefusee"
  | "complementDemande"
  | "parametresEnregistres";

/** Exécute le cas d'usage ; en cas d'erreur métier, revient sur `errorPath` avec le message. */
async function run(errorPath: string, action: () => Promise<unknown>, success: { path: string; message: CleSucces }): Promise<void> {
  let erreur: URLSearchParams | null = null;
  try {
    await action();
  } catch (e) {
    erreur = describeError(e);
  }
  // redirect() lève une exception de navigation : il doit rester hors du try/catch.
  if (erreur) redirect(`${errorPath}?${erreur}`);
  revalidatePath(success.path);
  redirect(`${success.path}?ok=${success.message}`);
}

/** Erreur → paramètres d'adresse : code, paramètres (JSON) et, pour la politique, contrôles en échec. */
function describeError(e: unknown): URLSearchParams {
  if (e instanceof PolicyViolationError) {
    return new URLSearchParams({ erreur: e.code, controles: e.failedChecks.map((c) => `${c.id}:${c.offending.join(",")}`).join(";") });
  }
  if (e instanceof PortalError) return new URLSearchParams({ erreur: e.code, details: JSON.stringify(e.params) });
  if (e instanceof z.ZodError) {
    return new URLSearchParams({ erreur: "saisie_invalide", details: JSON.stringify({ champs: e.issues.map((i) => i.path.join(".")).join(", ") }) });
  }
  throw e;
}

function keyRequestFromForm(formData: FormData) {
  return {
    teamId: text(formData, "teamId"),
    dataLevel: text(formData, "dataLevel") as DataLevel,
    models: formData.getAll("models").map(String),
    justification: text(formData, "justification"),
    project: optionalText(formData, "project"),
    requestedBudget: optionalNumber(formData, "requestedBudget"),
    requestedDays: optionalNumber(formData, "requestedDays"),
    keyType: text(formData, "keyType") as "PERSONNELLE" | "SERVICE",
    commitment: formData.get("commitment") === "on",
  };
}

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function optionalText(formData: FormData, name: string): string | null {
  return text(formData, name).trim() || null;
}

function optionalNumber(formData: FormData, name: string): number | null {
  const value = text(formData, name).trim();
  return value === "" ? null : Number(value);
}
