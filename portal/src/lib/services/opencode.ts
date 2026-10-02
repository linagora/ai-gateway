import type { SessionUser } from "@/lib/auth-user";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import type { ApiKind, LiteLLMModel } from "@/lib/litellm/client";
import type { DataLevel } from "@/lib/policy";
import { displayNames } from "./catalog";
import { type IssuedKey, type KeyDeps, listMyKeys, slug } from "./keys";

/** Textes de la configuration, dans la langue du collaborateur. */
export interface TextesOpenCode {
  /** Nom de chaque niveau de confidentialité. */
  niveaux: Record<DataLevel, string>;
  /** Invite de la saisie masquée d'une clé dans le terminal. */
  invite: (cle: { alias: string; niveau: string; equipe: string }) => string;
}

/** Politique de mise à jour d'OpenCode : signaler les nouvelles versions, les installer, ou ne pas vérifier. */
export const MISES_A_JOUR = ["notify", "auto", "disable"] as const;
export type MiseAJour = (typeof MISES_A_JOUR)[number];

/** Options de la page « Configurer OpenCode ». */
export interface OptionsOpenCode {
  langue: Langue;
  /** Adresse publique de l'API, celle des exemples d'appel. */
  adresseApi: string;
  textes: TextesOpenCode;
  /** Demandes des clés choisies ; null à l'arrivée sans choix : toutes les clés proposées. */
  requestIds: string[] | null;
  /** Modèle par défaut, désigné par sa référence ; ignoré s'il n'est pas parmi les modèles des clés choisies. */
  modeleParDefaut: string | null;
  /** Politique de mise à jour ; null : le réglage d'OpenCode reste. */
  miseAJour: MiseAJour | null;
}

/** Ce qui désigne une clé émise sur la page : sa demande, son alias, son équipe, son niveau et son projet. */
export type IdentiteCle = Pick<IssuedKey, "requestId" | "alias" | "teamAlias" | "dataLevel" | "project">;

/** Raison pour laquelle un modèle d'une clé n'entre pas dans la configuration : son type d'API, ou il n'est plus déclaré. */
export type RaisonModeleEcarte = Exclude<ApiKind, "conversation"> | "non_declare";

/** Clé émise proposée pour OpenCode, avec les modèles qu'elle y apporte. */
export interface CleOpenCode extends IdentiteCle {
  /** Identifiant de l'entrée de la clé dans OpenCode. */
  entree: string;
  /** La clé entre dans la configuration. */
  choisie: boolean;
  /**
   * Modèles de conversation de la clé, sous le nom affiché de leur fiche ; la référence, « entrée/modèle », désigne un
   * modèle dans OpenCode, par exemple comme modèle par défaut.
   */
  modeles: { modelName: string; displayName: string; reference: string }[];
  modelesEcartes: { modelName: string; raison: RaisonModeleEcarte }[];
}

/** Raison pour laquelle une clé émise n'est pas proposée. */
export type RaisonCleEcartee = "bloquee" | "sans_modele";

/** Clé émise qui n'est pas proposée pour OpenCode. */
export interface CleEcartee extends IdentiteCle {
  raison: RaisonCleEcartee;
}

/** Configuration d'OpenCode 2.x d'un collaborateur, à partir de ses clés émises. */
export interface ConfigurationOpenCode {
  /** Clés émises proposées, dans l'ordre de « Mes clés ». */
  cles: CleOpenCode[];
  clesEcartees: CleEcartee[];
  /** Modèle par défaut retenu : celui des options s'il est parmi les modèles des clés choisies. */
  modeleParDefaut: string | null;
  /** Texte du fichier de configuration d'OpenCode ; null sans clé choisie. */
  configuration: string | null;
  /** Commandes du terminal qui enregistrent les clés choisies, demandées en saisie masquée ; null sans clé choisie. */
  commandes: string | null;
  /** Commande qui liste les modèles qu'OpenCode reconnaît. */
  verification: string;
}

/** Paquet d'OpenCode pour une API compatible OpenAI. */
const PAQUET = "@opencode/ai/providers/openai-compatible";

/** Début de l'identifiant de chaque entrée, qui permet d'en lister les modèles. */
const PREFIXE = "linagora";

/** Clé proposée, avec les faits techniques de ses modèles retenus et le nom de sa variable d'environnement. */
interface ClePreparee extends Omit<CleOpenCode, "choisie" | "modeles"> {
  variable: string;
  retenus: { modelName: string; displayName: string; faits: LiteLLMModel }[];
}

/**
 * Configuration d'OpenCode : une entrée par clé émise, avec ses modèles de conversation. La clé n'y figure jamais,
 * seulement la variable d'environnement qui la contiendra.
 */
export async function configurationOpenCode(deps: KeyDeps, user: SessionUser, options: OptionsOpenCode): Promise<ConfigurationOpenCode> {
  const indisponible = () => new PortalError("passerelle_indisponible", "La passerelle ne répond pas : configuration d'OpenCode impossible.");
  const [{ keys }, modeles, noms] = await Promise.all([
    listMyKeys(deps, user),
    // Sans les faits techniques, la configuration serait incomplète : la passerelle est dite indisponible.
    deps.litellm.listModels().catch(() => {
      throw indisponible();
    }),
    displayNames(deps, options.langue),
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
  const choisie = (cle: ClePreparee) => options.requestIds === null || options.requestIds.includes(cle.requestId);
  const choisies = cles.filter(choisie);
  const references = choisies.flatMap((cle) => cle.retenus.map((m) => reference(cle, m.modelName)));
  const model = options.modeleParDefaut !== null && references.includes(options.modeleParDefaut) ? options.modeleParDefaut : null;
  const providers = Object.fromEntries(choisies.map((cle) => [cle.entree, entreeDeLaCle(cle, options)]));
  return {
    cles: cles.map((cle) => ({
      ...identite(cle),
      entree: cle.entree,
      choisie: choisie(cle),
      modeles: cle.retenus.map(({ modelName, displayName }) => ({ modelName, displayName, reference: reference(cle, modelName) })),
      modelesEcartes: cle.modelesEcartes,
    })),
    clesEcartees,
    modeleParDefaut: model,
    configuration:
      choisies.length === 0
        ? null
        : JSON.stringify({ ...(model && { model }), ...(options.miseAJour && { update: options.miseAJour }), providers }, null, 2),
    commandes: choisies.length === 0 ? null : commandes(choisies, options.textes),
    verification: `opencode reload && opencode models | grep ${PREFIXE}-`,
  };
}

/** Ce qui désigne une clé émise sur la page. */
function identite({ requestId, alias, teamAlias, dataLevel, project }: IdentiteCle): IdentiteCle {
  return { requestId, alias, teamAlias, dataLevel, project };
}

/** Référence d'un modèle dans OpenCode : l'entrée de sa clé, puis son nom dans la passerelle. */
function reference(cle: { entree: string }, modelName: string): string {
  return `${cle.entree}/${modelName}`;
}

/**
 * Identifiant de l'entrée de chaque clé, d'où vient aussi sa variable d'environnement : tiré du niveau, de l'équipe et du
 * projet de la clé, il ne change ni à son remplacement ni à son renouvellement. Entre deux clés qui auraient le même, la
 * plus ancienne le garde ; la fin de leur demande départage les suivantes.
 */
function nomsDesEntrees(cles: IssuedKey[]): string[] {
  const noms = cles.map((cle) => [PREFIXE, cle.dataLevel, cle.teamAlias, ...(cle.project ? [cle.project] : [])].map(slug).join("-"));
  return cles.map((cle, i) => {
    const plusAncienne = cles.filter((_, j) => noms[j] === noms[i]).reduce((a, b) => (b.issuedAt < a.issuedAt ? b : a));
    return plusAncienne === cle ? noms[i] : `${noms[i]}-${slug(cle.requestId.slice(-4))}`;
  });
}

/** Modèles retenus et écartés d'une clé, avec le nom de sa variable d'environnement. */
function preparer(cle: IssuedKey, entree: string, modeles: LiteLLMModel[], noms: Map<string, string>): ClePreparee {
  const preparee: ClePreparee = {
    ...identite(cle),
    entree,
    variable: `${entree.replaceAll("-", "_").toUpperCase()}_KEY`,
    modelesEcartes: [],
    retenus: [],
  };
  for (const nom of cle.models) {
    const faits = modeles.find((m) => m.modelName === nom);
    if (!faits) preparee.modelesEcartes.push({ modelName: nom, raison: "non_declare" });
    else if (faits.apiKind !== "conversation") preparee.modelesEcartes.push({ modelName: nom, raison: faits.apiKind });
    else preparee.retenus.push({ modelName: nom, displayName: noms.get(nom) ?? nom, faits });
  }
  return preparee;
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
 * Limites d'un modèle pour OpenCode : son contexte, et sa sortie maximale quand la passerelle la déclare, plafonnée par
 * le contexte (OpenCode réserve la sortie dans le contexte).
 */
function limite(contexte: number, sortie: number | null): { context: number; output?: number } {
  return sortie === null ? { context: contexte } : { context: contexte, output: Math.min(sortie, contexte) };
}

/** Tarif d'un modèle pour OpenCode, en dollars par million de jetons. */
interface TarifOpenCode {
  input: number;
  output: number;
  cache: { read: number; write: number };
}

/**
 * Coût d'un modèle pour OpenCode, qui n'affiche que des dollars par million de jetons : les prix en euros de la passerelle
 * divisés par son taux interne. Le cache sans prix déclaré coûte le prix d'entrée ; le palier au-delà de 200 000 jetons
 * s'ajoute quand il est déclaré. Sans taux ni prix, pas de coût.
 */
function cout(faits: LiteLLMModel): { cost?: TarifOpenCode | [TarifOpenCode, TarifOpenCode & { tier: { type: "context"; size: number } }] } {
  const { fxRateUsdEur: taux, inputCostPerToken: prixEntree, outputCostPerToken: prixSortie } = faits;
  if (taux === null || prixEntree === null || prixSortie === null) return {};
  const dollars = (eurosParJeton: number) => Number(((eurosParJeton * 1_000_000) / taux).toPrecision(6));
  const cache = { read: dollars(faits.cacheReadCostPerToken ?? prixEntree), write: dollars(faits.cacheWriteCostPerToken ?? prixEntree) };
  const tarif = { input: dollars(prixEntree), output: dollars(prixSortie), cache };
  if (faits.inputCostPerTokenAbove200k === null) return { cost: tarif };
  const palier = { input: dollars(faits.inputCostPerTokenAbove200k), output: dollars(faits.outputCostPerTokenAbove200k ?? prixSortie), cache };
  return { cost: [tarif, { tier: { type: "context", size: 200_000 }, ...palier }] };
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
        ...cout(faits),
        ...variantes(faits),
      },
    ]),
  );
  return { name, package: PAQUET, settings: { baseURL: options.adresseApi }, models };
}
