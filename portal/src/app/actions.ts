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
import { saveOffer } from "@/lib/services/offers";
import { blockKey, pickUpKey, replaceKey, revokeKey, unblockKey } from "@/lib/services/keys";
import { cancelRequest, completeRequest, createKeyRequest, createTeamJoinRequest } from "@/lib/services/requests";
import { saveSettings } from "@/lib/services/settings";
import { addTeamMember, createTeam, deleteTeam, designateManager, removeManager, removeTeamMember, renameTeam, setTeamBudget } from "@/lib/services/teams";
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

/** Spécification #51, ticket #53 : création ou modification d'une offre d'abonnement par un admin. */
export async function enregistrerOffreAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run(
    "/gestion/catalogue",
    () =>
      saveOffer(getDeps(), user, {
        id: optionalText(formData, "id") ?? undefined,
        supplier: text(formData, "supplier"),
        name: text(formData, "name"),
        monthlyPriceEur: optionalNumber(formData, "monthlyPriceEur") ?? Number.NaN,
        dataLevel: text(formData, "dataLevel") as DataLevel,
        rulesFr: text(formData, "rulesFr"),
        rulesEn: optionalText(formData, "rulesEn"),
        url: optionalText(formData, "url"),
        visible: formData.get("visible") === "on",
      }),
    { path: "/gestion/catalogue", message: "offreEnregistree" },
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

/** F-53 : création d'une équipe par un admin. */
export async function creerEquipeAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run("/gestion/equipes", () => createTeam(getDeps(), user, { name: text(formData, "nom") }), { path: "/gestion/equipes", message: "equipeCreee" });
}

/** F-53 : renommage d'une équipe par un admin. */
export async function renommerEquipeAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageEquipe(formData);
  await run(page, () => renameTeam(getDeps(), user, { teamId: text(formData, "id"), name: text(formData, "nom") }), { path: page, message: "equipeRenommee" });
}

/** F-53 : budget d'équipe et sa période, fixés par un admin ; 0 : sans limite. */
export async function fixerBudgetEquipeAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageEquipe(formData);
  await run(
    page,
    () => setTeamBudget(getDeps(), user, { teamId: text(formData, "id"), budget: optionalNumber(formData, "budget"), period: text(formData, "periode") }),
    { path: page, message: "budgetFixe" },
  );
}

/** F-53 : ajout direct d'un salarié à une équipe par un admin. */
export async function ajouterMembreAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageEquipe(formData);
  await run(page, () => addTeamMember(getDeps(), user, { teamId: text(formData, "id"), uid: text(formData, "uid") }), { path: page, message: "membreAjoute" });
}

/** F-54 : sortie d'une équipe, décidée par un admin ou un responsable de l'équipe. */
export async function faireSortirMembreAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageEquipe(formData);
  await run(page, () => removeTeamMember(getDeps(), user, { teamId: text(formData, "id"), uid: text(formData, "uid") }), { path: page, message: "membreSorti" });
}

/** F-53 : suppression d'une équipe par un admin ; en cas de refus, la page de l'équipe en donne la raison. */
export async function supprimerEquipeAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageEquipe(formData);
  await run(page, () => deleteTeam(getDeps(), user, text(formData, "id")), { path: "/gestion/equipes", message: "equipeSupprimee" });
}

/** F-54 : désignation d'un responsable d'équipe par un admin. */
export async function designerResponsableAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageEquipe(formData);
  await run(page, () => designateManager(getDeps(), user, { teamId: text(formData, "id"), uid: text(formData, "uid") }), { path: page, message: "responsableDesigne" });
}

/** F-54 : retrait du rôle de responsable par un admin. */
export async function retirerResponsableAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const page = pageEquipe(formData);
  await run(page, () => removeManager(getDeps(), user, { teamId: text(formData, "id"), uid: text(formData, "uid") }), { path: page, message: "responsableRetire" });
}

// --- outils ---

/** F-43 : révocation d'une clé par son titulaire. */
export async function revoquerCleAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run("/cles", () => revokeKey(getDeps(), user, text(formData, "id")), { path: "/cles", message: "cleRevoquee" });
}

/** F-43 : révocation d'une clé par un admin ou un responsable de son équipe, depuis « Gestion — Clés ». */
export async function revoquerCleAdminAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run("/gestion/cles", () => revokeKey(getDeps(), user, text(formData, "id")), { path: "/gestion/cles", message: "cleRevoquee" });
}

/** F-43 : blocage d'une clé par un admin ou un responsable de son équipe (suspension temporaire et réversible). */
export async function bloquerCleAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run("/gestion/cles", () => blockKey(getDeps(), user, text(formData, "id")), { path: "/gestion/cles", message: "cleBloquee" });
}

/** F-43 : déblocage d'une clé par un admin ou un responsable de son équipe. */
export async function debloquerCleAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  await run("/gestion/cles", () => unblockKey(getDeps(), user, text(formData, "id")), { path: "/gestion/cles", message: "cleDebloquee" });
}

/** Résultat du retrait d'une clé : la clé n'y figure qu'une fois, et nulle part ailleurs. */
export type ResultatRetrait = { ok: true; cle: string; alias: string } | { ok: false; erreur: string; details: Record<string, string> };

/**
 * F-40 / F-41 : retrait d'une clé. La clé n'est ni journalisée ni conservée ; la page n'est pas
 * rafraîchie ici, pour que le panneau d'affichage unique reste ouvert jusqu'à « J'ai copié ma clé ».
 */
export async function retirerCleAction(requestId: string): Promise<ResultatRetrait> {
  const user = await requireUser();
  return afficherUneFois(requestId, (id) => pickUpKey(getDeps(), user, id));
}

/** F-41 : remplacement d'une clé perdue ; la nouvelle clé s'affiche une seule fois, comme au retrait. */
export async function remplacerCleAction(requestId: string): Promise<ResultatRetrait> {
  const user = await requireUser();
  return afficherUneFois(requestId, (id) => replaceKey(getDeps(), user, id));
}

/** Identifiant de demande (cuid) : l'argument d'une Server Action peut être n'importe quelle valeur. */
const identifiantDemande = z.cuid();

async function afficherUneFois(requestId: unknown, generer: (id: string) => Promise<{ key: string; alias: string }>): Promise<ResultatRetrait> {
  const id = identifiantDemande.safeParse(requestId);
  if (!id.success) return { ok: false, erreur: "introuvable", details: { objet: "demande_cle" } };
  try {
    const { key, alias } = await generer(id.data);
    return { ok: true, cle: key, alias };
  } catch (e) {
    if (e instanceof PortalError) return { ok: false, erreur: e.code, details: e.params };
    throw e;
  }
}

/** Clés des messages de succès, traduites par l'avis (dictionnaires, espace « avis.succes »). */
type CleSucces =
  | "demandeEnvoyee"
  | "demandeResoumise"
  | "adhesionEnvoyee"
  | "demandeAnnulee"
  | "catalogueMisAJour"
  | "offreEnregistree"
  | "demandeApprouvee"
  | "adhesionApprouvee"
  | "demandeRefusee"
  | "complementDemande"
  | "parametresEnregistres"
  | "cleRevoquee"
  | "cleBloquee"
  | "cleDebloquee"
  | "equipeCreee"
  | "equipeRenommee"
  | "budgetFixe"
  | "membreAjoute"
  | "membreSorti"
  | "equipeSupprimee"
  | "responsableDesigne"
  | "responsableRetire";

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
    commitment: formData.get("commitment") === "on",
    renewsRequestId: optionalText(formData, "renewsRequestId"),
  };
}

/** Page de l'équipe visée par un formulaire de la gestion des équipes (champ « id »). */
function pageEquipe(formData: FormData): string {
  return `/gestion/equipes/${encodeURIComponent(text(formData, "id"))}`;
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
