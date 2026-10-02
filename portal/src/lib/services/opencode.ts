import type { SessionUser } from "@/lib/auth-user";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import type { ApiKind, LiteLLMModel } from "@/lib/litellm/client";
import type { DataLevel } from "@/lib/policy";
import { type IssuedKey, type KeyDeps, listMyKeys, slug } from "./keys";

/** Textes de la configuration, dans la langue du collaborateur. */
export interface TextesOpenCode {
  /** Nom de chaque niveau de confidentialité. */
  niveaux: Record<DataLevel, string>;
  /** Invite de la saisie masquée d'une clé dans le terminal. */
  invite: (cle: { alias: string; niveau: string; equipe: string }) => string;
}

/** Options de la page « Configurer OpenCode ». */
export interface OptionsOpenCode {
  langue: Langue;
  /** Adresse publique de l'API, celle des exemples d'appel. */
  adresseApi: string;
  textes: TextesOpenCode;
  /** Demandes des clés choisies ; null à l'arrivée sans choix : toutes les clés proposées. */
  cles: string[] | null;
}

/** Raison pour laquelle un modèle d'une clé n'entre pas dans la configuration. */
export type RaisonModeleEcarte = "images" | "decision" | "non_declare";

/** Clé émise proposée pour OpenCode, avec les modèles qu'elle y apporte. */
export interface CleOpenCode {
  requestId: string;
  alias: string;
  teamAlias: string;
  dataLevel: DataLevel;
  project: string | null;
  /** La clé entre dans la configuration. */
  choisie: boolean;
  /** Modèles de conversation de la clé, sous le nom affiché de leur fiche. */
  modeles: { modelName: string; displayName: string }[];
  modelesEcartes: { modelName: string; raison: RaisonModeleEcarte }[];
}

/** Raison pour laquelle une clé émise n'est pas proposée ; état inconnu : la passerelle ne dit pas si elle est bloquée. */
export type RaisonCleEcartee = "etat_inconnu" | "bloquee" | "sans_modele";

/** Clé émise qui n'est pas proposée pour OpenCode. */
export interface CleEcartee {
  requestId: string;
  alias: string;
  teamAlias: string;
  dataLevel: DataLevel;
  project: string | null;
  raison: RaisonCleEcartee;
}

/** Configuration d'OpenCode 2.x d'un collaborateur, à partir de ses clés émises. */
export interface ConfigurationOpenCode {
  /** Clés émises proposées, dans l'ordre de « Mes clés ». */
  cles: CleOpenCode[];
  clesEcartees: CleEcartee[];
  /** Texte du fichier de configuration d'OpenCode ; null sans clé choisie. */
  configuration: string | null;
  /** Commandes du terminal qui enregistrent les clés choisies, demandées en saisie masquée ; null sans clé choisie. */
  commandes: string | null;
  /** Commande qui liste les modèles qu'OpenCode reconnaît. */
  verification: string;
}

/** Paquet d'OpenCode pour une API compatible OpenAI. */
const PAQUET = "@opencode/ai/providers/openai-compatible";

/** Raison d'écarter un modèle qui n'est pas un modèle de conversation. */
const HORS_CONVERSATION: Record<Exclude<ApiKind, "conversation">, RaisonModeleEcarte> = { image: "images", decision: "decision" };

/** Fiche d'un modèle, réduite à son nom affiché. */
interface NomsAffiches {
  modelName: string;
  displayNameFr: string;
  displayNameEn: string | null;
}

/** Clé proposée, avec les faits techniques de ses modèles retenus. */
interface ClePreparee extends Omit<CleOpenCode, "modeles" | "choisie"> {
  entree: string;
  variable: string;
  retenus: { modelName: string; displayName: string; faits: LiteLLMModel }[];
}

/**
 * Configuration d'OpenCode : une entrée par clé émise, avec ses modèles de conversation. La clé n'y figure jamais,
 * seulement la variable d'environnement qui la contiendra.
 */
export async function configurationOpenCode(deps: KeyDeps, user: SessionUser, options: OptionsOpenCode): Promise<ConfigurationOpenCode> {
  const [{ keys }, modeles, fiches] = await Promise.all([
    listMyKeys(deps, user),
    // Sans les faits techniques, la configuration serait incomplète : la passerelle est dite indisponible.
    deps.litellm.listModels().catch(() => {
      throw new PortalError("passerelle_indisponible", "La passerelle ne répond pas : configuration d'OpenCode impossible.");
    }),
    deps.db.catalogEntry.findMany(),
  ]);
  const emises = keys.filter((k) => k.status === "CLE_EMISE");
  // Deux clés émises au même niveau, dans la même équipe et pour le même projet : la fin de leur demande les départage.
  const noms = emises.map(nomDEntree);
  const entrees = emises.map((cle, i) => (noms.indexOf(noms[i]) === noms.lastIndexOf(noms[i]) ? noms[i] : `${noms[i]}-${slug(cle.requestId.slice(-4))}`));
  const cles: ClePreparee[] = [];
  const clesEcartees: CleEcartee[] = [];
  for (const [i, cle] of emises.entries()) {
    const preparee = preparer(cle, entrees[i], modeles, fiches, options.langue);
    const { requestId, alias, teamAlias, dataLevel, project } = preparee;
    const raison: RaisonCleEcartee | null = !cle.gatewayState ? "etat_inconnu" : cle.gatewayState.blocked ? "bloquee" : preparee.retenus.length === 0 ? "sans_modele" : null;
    if (raison) clesEcartees.push({ requestId, alias, teamAlias, dataLevel, project, raison });
    else cles.push(preparee);
  }
  const choisie = (cle: ClePreparee) => options.cles === null || options.cles.includes(cle.requestId);
  const choisies = cles.filter(choisie);
  return {
    cles: cles.map((cle) => {
      const { requestId, alias, teamAlias, dataLevel, project, retenus, modelesEcartes } = cle;
      const modeles = retenus.map(({ modelName, displayName }) => ({ modelName, displayName }));
      return { requestId, alias, teamAlias, dataLevel, project, choisie: choisie(cle), modeles, modelesEcartes };
    }),
    clesEcartees,
    configuration:
      choisies.length === 0 ? null : JSON.stringify({ providers: Object.fromEntries(choisies.map((cle) => [cle.entree, entreeDeLaCle(cle, options)])) }, null, 2),
    commandes: choisies.length === 0 ? null : commandes(choisies, options.textes),
    verification: "opencode reload && opencode models | grep linagora-",
  };
}

/**
 * Enregistrement des clés auprès du service OpenCode : chaque clé est lue en saisie masquée (bash et zsh), jamais
 * écrite dans la commande, l'écran ni l'historique du shell ; puis le service redémarre.
 */
function commandes(cles: ClePreparee[], textes: TextesOpenCode): string {
  return [
    ...cles.flatMap((cle) => [
      `printf '%s' ${entreApostrophes(textes.invite({ alias: cle.alias, niveau: textes.niveaux[cle.dataLevel], equipe: cle.teamAlias }))}; read -rs K; echo`,
      `opencode service set env ${cle.variable} "$K"; unset K`,
    ]),
    "opencode service restart",
  ].join("\n");
}

/** Texte entre apostrophes pour le shell, où une apostrophe s'écrit '\''. */
function entreApostrophes(texte: string): string {
  return `'${texte.replaceAll("'", "'\\''")}'`;
}

/**
 * Identifiant de l'entrée d'une clé, d'où vient aussi sa variable d'environnement : tiré du niveau, de l'équipe et du
 * projet de la clé, il ne change ni à son remplacement ni à son renouvellement.
 */
function nomDEntree(cle: IssuedKey): string {
  return ["linagora", cle.dataLevel, cle.teamAlias, ...(cle.project ? [cle.project] : [])].map(slug).join("-");
}

/** Modèles retenus et écartés d'une clé, avec l'identifiant de son entrée et le nom de sa variable d'environnement. */
function preparer(cle: IssuedKey, entree: string, modeles: LiteLLMModel[], fiches: NomsAffiches[], langue: Langue): ClePreparee {
  const preparee: ClePreparee = {
    requestId: cle.requestId,
    alias: cle.alias,
    teamAlias: cle.teamAlias,
    dataLevel: cle.dataLevel,
    project: cle.project,
    modelesEcartes: [],
    entree,
    variable: `${entree.replaceAll("-", "_").toUpperCase()}_KEY`,
    retenus: [],
  };
  for (const nom of cle.models) {
    const faits = modeles.find((m) => m.modelName === nom);
    if (!faits) preparee.modelesEcartes.push({ modelName: nom, raison: "non_declare" });
    else if (faits.apiKind !== "conversation") preparee.modelesEcartes.push({ modelName: nom, raison: HORS_CONVERSATION[faits.apiKind] });
    else {
      const fiche = fiches.find((f) => f.modelName === nom);
      preparee.retenus.push({ modelName: nom, displayName: (fiche && ((langue === "en" && fiche.displayNameEn) || fiche.displayNameFr)) || nom, faits });
    }
  }
  return preparee;
}

/**
 * Limites d'un modèle pour OpenCode : son contexte, et sa sortie maximale quand la passerelle la déclare, plafonnée par
 * le contexte (OpenCode réserve la sortie dans le contexte).
 */
function limite(contexte: number, sortie: number | null): { context: number; output?: number } {
  return sortie === null ? { context: contexte } : { context: contexte, output: Math.min(sortie, contexte) };
}

/**
 * Variantes d'effort d'un modèle, choisies dans OpenCode : les efforts déclarés ; aucune pour un modèle sans raisonnement,
 * à qui OpenCode prêterait sinon des efforts inventés ; rien quand les efforts d'un modèle qui raisonne sont inconnus.
 */
function variantes(faits: LiteLLMModel): { variants?: { id: string; settings: { reasoningEffort: string } }[] } {
  if (!faits.capabilities.includes("raisonnement")) return { variants: [] };
  return faits.reasoningEfforts === null ? {} : { variants: faits.reasoningEfforts.map((effort) => ({ id: effort, settings: { reasoningEffort: effort } })) };
}

/** Entrée d'une clé dans le bloc `providers` d'OpenCode. */
function entreeDeLaCle(cle: ClePreparee, options: OptionsOpenCode) {
  const name = ["LINAGORA", options.textes.niveaux[cle.dataLevel], cle.teamAlias, ...(cle.project ? [cle.project] : [])].join(" · ");
  const models = Object.fromEntries(
    cle.retenus.map(({ modelName, displayName, faits }) => [
      modelName,
      {
        modelID: modelName,
        name: displayName,
        settings: { apiKey: `{env:${cle.variable}}` },
        // OpenCode ignore toute l'entrée si un modèle ne déclare pas `tools` : il est toujours déclaré. Sans contenus
        // déclarés, un modèle accepte le texte, et les images s'il les lit.
        capabilities: {
          tools: true,
          input: faits.inputContents ?? (faits.capabilities.includes("images") ? ["text", "image"] : ["text"]),
          output: faits.outputContents ?? ["text"],
        },
        ...(faits.maxInputTokens === null ? {} : { limit: limite(faits.maxInputTokens, faits.maxOutputTokens) }),
        ...variantes(faits),
      },
    ]),
  );
  return { name, package: PAQUET, settings: { baseURL: options.adresseApi }, models };
}
