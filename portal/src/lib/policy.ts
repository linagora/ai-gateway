/** Règles métier du portail (brief §4). Fonctions pures, sans accès réseau ni base. */

/**
 * Niveau de sensibilité des données (PRD §5) : N1 public < N2 interne < N3 confidentiel, plus
 * EXP (expérimental) : modèles en bêta, données publiques uniquement, dans des clés dédiées.
 */
export const DATA_LEVELS = ["N1", "N2", "N3", "EXP"] as const;
export type DataLevel = (typeof DATA_LEVELS)[number];

/** Classification des informations de LINAGORA : NC (public), C1 (interne), C2 (restreint), C3 (secret). */
export type Classification = "NC" | "C1" | "C2" | "C3";

/**
 * Classifications que chaque niveau accepte (décision du 2026-09-26) : le niveau Expérimental, réservé aux données
 * publiques, n'accepte que NC.
 */
export const CLASSIFICATIONS_ACCEPTEES: Record<DataLevel, readonly Classification[]> = { N1: ["NC", "C1"], N2: ["C2"], N3: ["C3"], EXP: ["NC"] };

const LEVEL_RANK: Record<Exclude<DataLevel, "EXP">, number> = { N1: 1, N2: 2, N3: 3 };

/** Règle 1 : un utilisateur est admin si son uid figure dans PORTAL_ADMIN_UIDS. */
export function isAdmin(uid: string, adminUids: readonly string[]): boolean {
  return adminUids.includes(uid);
}

/** Utilisateur connecté, tel que la politique le voit. */
export interface PortalUser {
  uid: string;
  isAdmin: boolean;
}

/** Règle 2 : un utilisateur ne voit et ne modifie que ses demandes ; un admin voit tout. */
export function canAccessRequest(user: PortalUser, request: { requesterUid: string }): boolean {
  return user.isAdmin || request.requesterUid === user.uid;
}

/**
 * Un modèle peut traiter des données jusqu'à son propre niveau (PRD §5). Le niveau expérimental ne
 * se mélange pas aux autres : ses modèles n'entrent que dans des clés Expérimental, et inversement.
 */
export function modelAcceptsLevel(modelLevel: DataLevel, requestedLevel: DataLevel): boolean {
  if (modelLevel === "EXP" || requestedLevel === "EXP") return modelLevel === requestedLevel;
  return LEVEL_RANK[modelLevel] >= LEVEL_RANK[requestedLevel];
}

/** Modèle du catalogue enrichi, tel que la politique le voit. */
export interface CatalogModel {
  modelName: string;
  dataLevel: DataLevel;
  visible: boolean;
}

/** Équipe LiteLLM, réduite à ce dont la politique a besoin. */
export interface TeamForPolicy {
  teamId: string;
  models: readonly string[];
  memberUids: readonly string[];
}

/** Paramètres d'une demande de clé, à la soumission ou tels que modifiés par l'admin. */
export interface KeyRequestDraft {
  requesterUid: string;
  teamId: string;
  dataLevel: DataLevel;
  models: readonly string[];
}

export type PolicyCheckId = "membre_equipe" | "modeles_presents" | "modeles_equipe" | "niveau_modeles" | "modeles_visibles";

/** Un contrôle, affiché réussi ou en échec sur la fiche de validation ; `offending` liste les éléments en cause. */
export interface PolicyCheck {
  id: PolicyCheckId;
  ok: boolean;
  offending: string[];
}

export interface PolicyVerdict {
  ok: boolean;
  checks: PolicyCheck[];
}

/** Règle 3 : contrôles d'une demande de clé, rejoués à la soumission, à l'approbation et à la génération. */
export function checkKeyRequest(draft: KeyRequestDraft, team: TeamForPolicy, catalog: readonly CatalogModel[]): PolicyVerdict {
  const checks: PolicyCheck[] = [
    check("membre_equipe", team.memberUids.includes(draft.requesterUid) ? [] : [draft.requesterUid]),
    { id: "modeles_presents", ok: draft.models.length > 0, offending: [] },
    check("modeles_equipe", teamAllowsAllModels(team) ? [] : draft.models.filter((m) => !team.models.includes(m))),
    // Un modèle absent du catalogue est signalé par le contrôle de visibilité, pas ici.
    check("niveau_modeles", draft.models.filter((m) => {
      const entry = catalog.find((c) => c.modelName === m);
      return entry !== undefined && !modelAcceptsLevel(entry.dataLevel, draft.dataLevel);
    })),
    check("modeles_visibles", draft.models.filter((m) => !catalog.some((c) => c.modelName === m && c.visible))),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Sémantique LiteLLM (vérifiée sur la 1.102.1) : une équipe sans liste de modèles, ou contenant
 * « all-proxy-models », a accès à tous les modèles. Les niveaux et la visibilité restent contrôlés.
 */
function teamAllowsAllModels(team: TeamForPolicy): boolean {
  return team.models.length === 0 || team.models.includes("all-proxy-models");
}

function check(id: PolicyCheckId, offending: string[]): PolicyCheck {
  return { id, ok: offending.length === 0, offending };
}

export type RequestStatus = "SOUMISE" | "A_COMPLETER" | "ACCORD_RESPONSABLE" | "APPROUVEE" | "REFUSEE" | "ANNULEE" | "CLE_EMISE" | "EXPIREE" | "REVOQUEE" | "DECLAREE" | "RENOUVELEE";

/**
 * Statuts d'une demande pas encore décidée, ni approuvée ni refusée : soumise, renvoyée à son demandeur pour
 * complément, ou demande d'abonnement qui a reçu l'accord du responsable et attend l'approbation d'un admin
 * (spécification #93). Seule définition de ces statuts : les demandes « en cours » en partent (sortie et suppression
 * d'une équipe, demande en double, renouvellement qui suspend la demande de résiliation à l'échéance), et le demandeur
 * peut annuler une telle demande.
 */
export const STATUTS_PAS_ENCORE_DECIDES = ["SOUMISE", "A_COMPLETER", "ACCORD_RESPONSABLE"] as const satisfies readonly RequestStatus[];

/** La demande n'est-elle pas encore décidée ? */
export function pasEncoreDecidee(status: RequestStatus): boolean {
  return (STATUTS_PAS_ENCORE_DECIDES as readonly RequestStatus[]).includes(status);
}

/**
 * Statuts d'une demande en attente de validation, celles que montre la file : soumise, ou demande d'abonnement qui a
 * reçu l'accord du responsable et attend l'approbation d'un admin (spécification #93). Une demande à compléter attend
 * son demandeur.
 */
export const STATUTS_EN_ATTENTE_DE_VALIDATION = ["SOUMISE", "ACCORD_RESPONSABLE"] as const satisfies readonly RequestStatus[];

/** La demande est-elle en attente de validation ? */
export function enAttenteDeValidation(status: RequestStatus): boolean {
  return (STATUTS_EN_ATTENTE_DE_VALIDATION as readonly RequestStatus[]).includes(status);
}

export type RequestKind = "CLE" | "ADHESION_EQUIPE" | "ABONNEMENT";

/** Demande de la file de validation, telle que la politique la voit. */
export interface DemandeDeLaFile {
  kind: RequestKind;
  status: RequestStatus;
  requesterUid: string;
}

/**
 * Spécification #93 : une demande d'abonnement soumise attend l'accord d'un responsable si son équipe en a un autre que
 * son demandeur ; sinon, elle attend directement l'approbation d'un admin. L'étape se déduit des responsables de
 * l'équipe, sans être stockée : désigner ou retirer un responsable la change.
 */
export function attendUnResponsable(demande: DemandeDeLaFile, responsables: readonly string[]): boolean {
  return demande.kind === "ABONNEMENT" && demande.status === "SOUMISE" && responsables.some((uid) => uid !== demande.requesterUid);
}

/**
 * La demande de la file, dont l'équipe a ces responsables, attend-elle cet acteur (spécification #93) ? Un responsable
 * traite les demandes soumises de ses équipes, hors les siennes ; une demande qui a reçu l'accord attend un admin. Un
 * admin traite toute la file, sauf une demande d'abonnement qui attend l'accord d'un responsable qu'il n'est pas
 * lui-même : responsable de l'équipe, il en reçoit les demandes et les approuve en un seul temps.
 */
export function attendLActeur(acteur: PortalUser, demande: DemandeDeLaFile, responsables: readonly string[]): boolean {
  if (!acteur.isAdmin) return demande.status === "SOUMISE" && demande.requesterUid !== acteur.uid;
  return !attendUnResponsable(demande, responsables) || (acteur.uid !== demande.requesterUid && responsables.includes(acteur.uid));
}

/** Règle 5 : seules ces transitions sont autorisées ; les autres statuts sont finaux. */
const ALLOWED_TRANSITIONS: Partial<Record<RequestStatus, readonly RequestStatus[]>> = {
  SOUMISE: ["APPROUVEE", "REFUSEE", "A_COMPLETER", "ANNULEE", "ACCORD_RESPONSABLE"],
  A_COMPLETER: ["SOUMISE", "ANNULEE"],
  // ACCORD_RESPONSABLE : demande d'abonnement qui a reçu l'accord du responsable ; un admin l'approuve
  // (spécification #93).
  ACCORD_RESPONSABLE: ["APPROUVEE", "ANNULEE"],
  // ANNULEE : sortie d'une équipe avant le retrait de la clé (F-54) ; DECLAREE : abonnement déclaré, RENOUVELEE :
  // renouvellement d'abonnement appliqué à son approbation (spécification #51).
  APPROUVEE: ["CLE_EMISE", "DECLAREE", "RENOUVELEE", "EXPIREE", "ANNULEE"],
  CLE_EMISE: ["REVOQUEE", "EXPIREE"],
};

export type TransitionCheck = { ok: true } | { ok: false; reason: "transition_interdite" | "motif_obligatoire" };

export function checkTransition(from: RequestStatus, to: RequestStatus, options: { comment?: string } = {}): TransitionCheck {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) return { ok: false, reason: "transition_interdite" };
  if (to === "REFUSEE" && !options.comment?.trim()) return { ok: false, reason: "motif_obligatoire" };
  return { ok: true };
}
