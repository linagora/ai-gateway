import type { SessionUser } from "@/lib/auth-user";
import type { Langue } from "@/lib/langue";
import { entreApostrophes } from "@/lib/shell";
import {
  type CleDesignee,
  type CleEcartee,
  type ClePreparee,
  type CleProposee,
  choisie,
  cleProposee,
  designee,
  preparerLesCles,
  reference,
  type TextesDesCles,
} from "./cles-assistants";
import type { KeyDeps } from "./keys";

/** Textes des commandes et des lanceurs, dans la langue du collaborateur. */
export interface TextesClaudeCode extends TextesDesCles {
  /** Libellé de la clé dans le trousseau. */
  libelle: (cle: CleDesignee) => string;
  /** Commentaire d'en-tête du lanceur ; `details` : niveau, équipe et, s'il y en a un, projet de la clé. */
  enTete: (cle: { alias: string; details: string }) => string;
  /** Commentaire : une autre clé Anthropic de l'environnement aurait priorité. */
  priorite: string;
  /**
   * Commentaire du trafic non essentiel coupé : ni télémétrie, ni rapports d'erreur, ni mise à jour automatique. D'autres
   * appels restent possibles (contrôle de domaine de WebFetch, recherche sur le web, extensions) : pas de promesse que seule
   * la passerelle est appelée.
   */
  trafic: string;
  /** Commentaire : l'adresse est sans /v1, que Claude Code ajoute lui-même. */
  adresse: string;
  /** Message d'erreur du lanceur quand le trousseau n'a pas la clé. */
  introuvable: string;
  /** Commentaire du modèle par défaut, quand la clé n'en a pas d'autre. */
  modeleUnique: string;
  /** Commentaire du modèle par défaut, avec les autres modèles de la clé, à choisir par /model. */
  autresModeles: (liste: string) => string;
  /** Commentaire : fenêtre de contexte déclarée par la passerelle, la plus petite des modèles de la clé. */
  contexte: string;
  /** Question de la vérification, à laquelle le modèle répond OK. */
  question: string;
}

/** Options de la page « Configurer Claude Code ». */
export interface OptionsClaudeCode {
  langue: Langue;
  /** Adresse publique de l'API, celle des exemples d'appel, terminée par /v1. */
  adresseApi: string;
  textes: TextesClaudeCode;
  /** Demandes des clés choisies ; null à l'arrivée sans choix : toutes les clés proposées. */
  requestIds: string[] | null;
  /** Modèles par défaut des clés, désignés par leur référence ; une clé sans le sien prend son premier modèle. */
  modelesParDefaut: string[];
}

/**
 * Clé émise proposée pour Claude Code : son entrée est son identifiant dans le trousseau, d'où vient le nom de son
 * lanceur ; une clé choisie a un lanceur.
 */
export interface CleClaudeCode extends CleProposee {
  /** Commande qui lance Claude Code avec la clé, installée dans ~/.local/bin. */
  lanceur: string;
  /** Référence du modèle par défaut de la clé : celui des options s'il est parmi ses modèles, sinon le premier. */
  modeleParDefaut: string;
}

/** Ce qu'il faut pour lancer Claude Code sur la passerelle avec les clés émises d'un collaborateur. */
export interface ConfigurationClaudeCode {
  /** Clés émises proposées, dans l'ordre de « Mes clés ». */
  cles: CleClaudeCode[];
  clesEcartees: CleEcartee[];
  /** Commandes du terminal qui enregistrent les clés choisies dans le trousseau, en saisie masquée ; null sans clé choisie. */
  commandes: string | null;
  /** Commande qui installe un lanceur par clé choisie ; null sans clé choisie. */
  lanceurs: string | null;
  /** Commandes qui posent une question à chaque lanceur ; null sans clé choisie. */
  verification: string | null;
}

/** Service des clés dans le trousseau GNOME (libsecret). */
const SERVICE = "linagora-ai-gateway";

/** Fin du document en ligne qui écrit un lanceur. */
const FIN = "FIN_LINAGORA";

/** Variables qui désignent le modèle de Claude Code : conversation, alias opus, sonnet et haiku (tâches de fond), sous-agents. */
const VARIABLES_DU_MODELE = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/** Clé choisie avec son modèle par défaut. */
interface CleAvecModele extends ClePreparee {
  modeleParDefaut: ClePreparee["retenus"][number];
}

/**
 * Claude Code sur la passerelle : chaque clé choisie est enregistrée dans le trousseau GNOME, puis lue au lancement par son
 * lanceur, qui donne à Claude Code l'adresse de la passerelle et le modèle par défaut de la clé. La clé n'y figure jamais.
 */
export async function configurationClaudeCode(deps: KeyDeps, user: SessionUser, options: OptionsClaudeCode): Promise<ConfigurationClaudeCode> {
  const { cles: preparees, clesEcartees } = await preparerLesCles(deps, user, options.langue);
  const cles: CleAvecModele[] = preparees.map((cle) => ({
    ...cle,
    modeleParDefaut: cle.retenus.find((m) => options.modelesParDefaut.includes(reference(cle, m.modelName))) ?? cle.retenus[0],
  }));
  const choisies = cles.filter((cle) => choisie(cle, options.requestIds));
  const aucune = choisies.length === 0;
  return {
    cles: cles.map((cle) => ({
      ...cleProposee(cle, options.requestIds),
      lanceur: lanceur(cle),
      modeleParDefaut: reference(cle, cle.modeleParDefaut.modelName),
    })),
    clesEcartees,
    commandes: aucune ? null : commandes(choisies, options.textes),
    lanceurs: aucune ? null : lanceurs(choisies, options),
    verification: aucune ? null : choisies.map((cle) => `${lanceur(cle)} -p ${valeur(options.textes.question)}`).join("\n"),
  };
}

/** Nom du lanceur d'une clé, dans ~/.local/bin. */
function lanceur(cle: { entree: string }): string {
  return `claude-${cle.entree}`;
}

/**
 * Enregistrement des clés dans le trousseau GNOME : chaque clé est lue en saisie masquée (bash et zsh), puis passée à
 * secret-tool par l'entrée standard, jamais écrite dans la commande, l'écran ni l'historique du shell.
 */
function commandes(cles: ClePreparee[], textes: TextesClaudeCode): string {
  return cles
    .flatMap((cle) => [
      `printf '%s' ${valeur(textes.invite(designee(cle, textes.niveaux)))}; read -rs K; echo`,
      `printf '%s' "$K" | secret-tool store --label=${valeur(textes.libelle(designee(cle, textes.niveaux)))} service ${SERVICE} cle ${cle.entree}; unset K`,
    ])
    .join("\n");
}

/** Commande qui écrit le lanceur de chaque clé dans ~/.local/bin et le rend exécutable. */
function lanceurs(cles: CleAvecModele[], options: OptionsClaudeCode): string {
  return [
    "mkdir -p ~/.local/bin",
    ...cles.flatMap((cle) => [
      `cat > ~/.local/bin/${lanceur(cle)} <<'${FIN}'`,
      scriptDuLanceur(cle, options),
      FIN,
      `chmod +x ~/.local/bin/${lanceur(cle)}`,
    ]),
  ].join("\n");
}

/**
 * Texte sur une seule ligne : le projet, l'équipe ou le nom d'un modèle qui contiendrait un retour à la ligne pourrait
 * sinon fermer le document en ligne du lanceur (une ligne FIN_LINAGORA) et faire exécuter la suite par le shell.
 */
function uneLigne(texte: string): string {
  return texte.replace(/[\r\n]+/g, " ");
}

/** Ligne de commentaire du lanceur. */
function commentaire(texte: string): string {
  return `# ${uneLigne(texte)}`;
}

/** Valeur entre apostrophes pour le shell, sur une seule ligne. */
function valeur(texte: string): string {
  return entreApostrophes(uneLigne(texte));
}

/**
 * Lanceur d'une clé : il lit la clé dans le trousseau, la donne à Claude Code comme jeton (envoyé en
 * `Authorization: Bearer`), avec l'adresse de la passerelle sans /v1 et le même modèle pour la conversation, les tâches de
 * fond et les sous-agents ; une clé absente ou vide du trousseau arrête le lanceur. Claude Code ne connaît pas les modèles
 * de la passerelle : la fenêtre de contexte lui est donnée, sans quoi il en supposerait une de 200 000 jetons. C'est le
 * plus petit des contextes déclarés des modèles de la clé, puisque /model change de modèle en cours de session sans que
 * la variable suive. Un modèle par défaut sans contexte déclaré n'en reçoit pas, plutôt qu'un contexte deviné d'après
 * les autres modèles, comme pour OpenCode.
 */
function scriptDuLanceur(cle: CleAvecModele, { adresseApi, textes }: OptionsClaudeCode): string {
  const { modelName, faits } = cle.modeleParDefaut;
  const details = [textes.niveaux[cle.dataLevel], cle.teamAlias, ...(cle.project ? [cle.project] : [])].join(", ");
  const autres = cle.retenus.filter((m) => m.modelName !== modelName).map((m) => m.modelName);
  const contextes = cle.retenus.flatMap((m) => (m.faits.maxInputTokens === null ? [] : [m.faits.maxInputTokens]));
  return [
    "#!/bin/bash",
    commentaire(textes.enTete({ alias: cle.alias, details })),
    "set -euo pipefail",
    commentaire(textes.priorite),
    "unset ANTHROPIC_API_KEY",
    commentaire(textes.trafic),
    "export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    commentaire(textes.adresse),
    `export ANTHROPIC_BASE_URL=${valeur(adresseApi.replace(/\/v1\/?$/, ""))}`,
    `ANTHROPIC_AUTH_TOKEN=$(secret-tool lookup service ${SERVICE} cle ${cle.entree}) && [ -n "$ANTHROPIC_AUTH_TOKEN" ] || { echo ${valeur(textes.introuvable)} >&2; exit 1; }`,
    "export ANTHROPIC_AUTH_TOKEN",
    commentaire(autres.length === 0 ? textes.modeleUnique : textes.autresModeles(autres.join(", "))),
    ...VARIABLES_DU_MODELE.map((variable) => `export ${variable}=${valeur(modelName)}`),
    ...(faits.maxInputTokens === null ? [] : [commentaire(textes.contexte), `export CLAUDE_CODE_MAX_CONTEXT_TOKENS=${Math.min(...contextes)}`]),
    'exec claude "$@"',
  ].join("\n");
}
