import type { SessionUser } from "@/lib/auth-user";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import type { ApiKind, LiteLLMModel } from "@/lib/litellm/client";
import { displayNames } from "./catalog";
import { type IssuedKey, type KeyDeps, listMyKeys, slug } from "./keys";

/*
 * Préparation des clés émises d'un collaborateur pour un assistant de code (OpenCode, Claude Code) : chaque clé reçoit un
 * identifiant stable, ses modèles de conversation sont retenus et les autres écartés avec la raison. La clé elle-même n'y
 * figure jamais.
 */

/** Ce qui désigne une clé émise sur la page : sa demande, son alias, son équipe, son niveau et son projet. */
export type IdentiteCle = Pick<IssuedKey, "requestId" | "alias" | "teamAlias" | "dataLevel" | "project">;

/** Raison pour laquelle un modèle d'une clé n'entre pas dans la configuration : son type d'API, ou il n'est plus déclaré. */
export type RaisonModeleEcarte = Exclude<ApiKind, "conversation"> | "non_declare";

/** Raison pour laquelle une clé émise n'est pas proposée. */
export type RaisonCleEcartee = "bloquee" | "sans_modele";

/** Clé émise qui n'est pas proposée à l'assistant. */
export interface CleEcartee extends IdentiteCle {
  raison: RaisonCleEcartee;
}

/** Modèle de conversation retenu d'une clé, sous le nom affiché de sa fiche, avec ses faits techniques. */
export interface ModeleRetenu {
  modelName: string;
  displayName: string;
  faits: LiteLLMModel;
}

/** Modèle d'une clé proposé sur la page ; sa référence, « entrée/modèle », le désigne parmi les modèles de toutes les clés. */
export interface ModelePropose {
  modelName: string;
  displayName: string;
  reference: string;
}

/** Clé émise proposée, avec son identifiant stable, ses modèles retenus et ses modèles écartés. */
export interface ClePreparee extends IdentiteCle {
  /** Identifiant stable de la clé auprès de l'assistant, par exemple `linagora-n2-r-d-compte-rendu-hebdo`. */
  entree: string;
  retenus: ModeleRetenu[];
  modelesEcartes: { modelName: string; raison: RaisonModeleEcarte }[];
}

/** Début de l'identifiant de chaque entrée, qui permet de reconnaître les entrées de la passerelle. */
export const PREFIXE = "linagora";

/**
 * Clés émises du collaborateur, préparées pour un assistant : les clés proposées, dans l'ordre de « Mes clés », et celles
 * qui ne le sont pas, avec la raison. Quand la passerelle ne donne pas les modèles ou l'état d'une clé, rien n'est
 * préparé : la passerelle est dite indisponible.
 */
export async function preparerLesCles(deps: KeyDeps, user: SessionUser, langue: Langue): Promise<{ cles: ClePreparee[]; clesEcartees: CleEcartee[] }> {
  const indisponible = () => new PortalError("passerelle_indisponible", "La passerelle ne répond pas : configuration de l'assistant de code impossible.");
  const [{ keys }, modeles, noms] = await Promise.all([
    listMyKeys(deps, user),
    // Sans les faits techniques, la configuration serait incomplète : la passerelle est dite indisponible.
    deps.litellm.listModels().catch(() => {
      throw indisponible();
    }),
    displayNames(deps, langue),
  ]);
  const emises = keys.filter((k) => k.status === "CLE_EMISE");
  // Sans l'état d'une clé, on ne sait pas si elle est bloquée : pas de configuration partielle.
  if (emises.some((k) => k.gatewayState === null)) throw indisponible();
  const entrees = nomsDesEntrees(emises);
  const cles: ClePreparee[] = [];
  const clesEcartees: CleEcartee[] = [];
  for (const [i, cle] of emises.entries()) {
    const preparee = preparer(cle, entrees[i], modeles, noms);
    if (cle.gatewayState?.blocked) clesEcartees.push({ ...identite(cle), raison: "bloquee" });
    else if (preparee.retenus.length === 0) clesEcartees.push({ ...identite(cle), raison: "sans_modele" });
    else cles.push(preparee);
  }
  return { cles, clesEcartees };
}

/** Ce qui désigne une clé émise sur la page. */
export function identite({ requestId, alias, teamAlias, dataLevel, project }: IdentiteCle): IdentiteCle {
  return { requestId, alias, teamAlias, dataLevel, project };
}

/** Référence d'un modèle : l'entrée de sa clé, puis son nom dans la passerelle. */
export function reference(cle: { entree: string }, modelName: string): string {
  return `${cle.entree}/${modelName}`;
}

/** Modèles retenus d'une clé, tels que la page les propose. */
export function modelesProposes(cle: ClePreparee): ModelePropose[] {
  return cle.retenus.map(({ modelName, displayName }) => ({ modelName, displayName, reference: reference(cle, modelName) }));
}

/**
 * Identifiant de l'entrée de chaque clé : tiré du niveau, de l'équipe et du projet de la clé, il ne change ni à son
 * remplacement ni à son renouvellement. Entre deux clés qui auraient le même, la plus ancienne le garde ; la fin de leur
 * demande départage les suivantes.
 */
function nomsDesEntrees(cles: IssuedKey[]): string[] {
  const noms = cles.map((cle) => [PREFIXE, cle.dataLevel, cle.teamAlias, ...(cle.project ? [cle.project] : [])].map(slug).join("-"));
  return cles.map((cle, i) => {
    const plusAncienne = cles.filter((_, j) => noms[j] === noms[i]).reduce((a, b) => (b.issuedAt < a.issuedAt ? b : a));
    return plusAncienne === cle ? noms[i] : `${noms[i]}-${slug(cle.requestId.slice(-4))}`;
  });
}

/** Modèles de conversation retenus d'une clé, et ses autres modèles écartés avec la raison. */
function preparer(cle: IssuedKey, entree: string, modeles: LiteLLMModel[], noms: Map<string, string>): ClePreparee {
  const preparee: ClePreparee = { ...identite(cle), entree, modelesEcartes: [], retenus: [] };
  for (const nom of cle.models) {
    const faits = modeles.find((m) => m.modelName === nom);
    if (!faits) preparee.modelesEcartes.push({ modelName: nom, raison: "non_declare" });
    else if (faits.apiKind !== "conversation") preparee.modelesEcartes.push({ modelName: nom, raison: faits.apiKind });
    else preparee.retenus.push({ modelName: nom, displayName: noms.get(nom) ?? nom, faits });
  }
  return preparee;
}
