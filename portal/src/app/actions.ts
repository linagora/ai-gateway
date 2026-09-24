"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { signOut } from "@/auth";
import { PolicyViolationError, PortalError } from "@/lib/errors";
import { CHECK_LABELS } from "@/lib/labels";
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
    { path: "/demandes", message: completing ? "Demande complétée et resoumise." : "Demande envoyée aux administrateurs." },
  );
}

export async function createTeamJoinRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run(
    "/demandes/adhesion",
    () => createTeamJoinRequest(getDeps(), user, { teamId: text(formData, "teamId"), justification: text(formData, "justification") }),
    { path: "/demandes", message: "Demande d'adhésion envoyée." },
  );
}

export async function cancelRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run("/demandes", () => cancelRequest(getDeps(), user, text(formData, "id")), { path: "/demandes", message: "Demande annulée." });
}

export async function saveCatalogEntryAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run(
    "/gestion/catalogue",
    () =>
      saveCatalogEntry(getDeps(), user, {
        modelName: text(formData, "modelName"),
        displayName: text(formData, "displayName"),
        description: text(formData, "description"),
        useCases: optionalText(formData, "useCases"),
        category: optionalText(formData, "category"),
        hosting: text(formData, "hosting") as "INTERNE" | "UE" | "HORS_UE",
        dataLevel: text(formData, "dataLevel") as "N1" | "N2" | "N3",
        visible: formData.get("visible") === "on",
      }),
    { path: "/gestion/catalogue", message: "Catalogue mis à jour." },
  );
}

export async function approveKeyRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(formData, "id");
  await run(
    `/gestion/demandes/${id}`,
    () =>
      approveKeyRequest(getDeps(), user, id, {
        models: formData.getAll("models").map(String),
        budget: optionalNumber(formData, "budget"),
        budgetDuration: optionalText(formData, "budgetDuration"),
        days: optionalNumber(formData, "days"),
        rpmLimit: optionalNumber(formData, "rpmLimit"),
        tpmLimit: optionalNumber(formData, "tpmLimit"),
      }),
    { path: "/gestion/demandes", message: "Demande approuvée." },
  );
}

export async function approveTeamJoinRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(formData, "id");
  await run(`/gestion/demandes/${id}`, () => approveTeamJoinRequest(getDeps(), user, id), {
    path: "/gestion/demandes",
    message: "Adhésion approuvée : le demandeur a été ajouté à l'équipe.",
  });
}

export async function refuseRequestAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(formData, "id");
  await run(`/gestion/demandes/${id}`, () => refuseRequest(getDeps(), user, id, text(formData, "comment")), {
    path: "/gestion/demandes",
    message: "Demande refusée.",
  });
}

export async function requestCompletionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = text(formData, "id");
  await run(`/gestion/demandes/${id}`, () => requestCompletion(getDeps(), user, id, text(formData, "comment")), {
    path: "/gestion/demandes",
    message: "Demande renvoyée au demandeur pour complément.",
  });
}

export async function saveSettingsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const keys = ["default_budget", "default_budget_duration", "default_days", "default_rpm", "default_tpm", "pickup_days"] as const;
  const values = Object.fromEntries(keys.flatMap((k) => (optionalText(formData, k) ? [[k, optionalText(formData, k)]] : [])));
  await run("/gestion/parametres", () => saveSettings(getDeps(), user, values), { path: "/gestion/parametres", message: "Paramètres enregistrés." });
}

// --- outils ---

/** Exécute le cas d'usage ; en cas d'erreur métier, revient sur `errorPath` avec le message. */
async function run(errorPath: string, action: () => Promise<unknown>, success: { path: string; message: string }): Promise<void> {
  let error: string | null = null;
  try {
    await action();
  } catch (e) {
    error = describeError(e);
  }
  // redirect() lève une exception de navigation : il doit rester hors du try/catch.
  if (error) redirect(`${errorPath}?erreur=${encodeURIComponent(error)}`);
  revalidatePath(success.path);
  redirect(`${success.path}?ok=${encodeURIComponent(success.message)}`);
}

function describeError(e: unknown): string {
  if (e instanceof PolicyViolationError) {
    return `${e.message} Contrôles en échec : ${e.failedChecks.map((c) => `${CHECK_LABELS[c.id]}${c.offending.length ? ` (${c.offending.join(", ")})` : ""}`).join(" ; ")}.`;
  }
  if (e instanceof PortalError) return e.message;
  if (e instanceof z.ZodError) return `Saisie invalide : ${e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join(" ; ")}.`;
  throw e;
}

function keyRequestFromForm(formData: FormData) {
  return {
    teamId: text(formData, "teamId"),
    dataLevel: text(formData, "dataLevel") as "N1" | "N2" | "N3",
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
