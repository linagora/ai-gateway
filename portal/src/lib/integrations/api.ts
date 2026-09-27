import "server-only";
import { createTranslator, type Messages } from "next-intl";
import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import { PolicyViolationError, PortalError, type PortalErrorCode } from "@/lib/errors";
import { type Langue, langueDemandee } from "@/lib/langue";
import { LimiteDeDebit } from "@/lib/limite-de-debit";
import { LiteLLMError } from "@/lib/litellm/client";
import { lireIntegrationAppelante, type Perimetre } from "@/lib/services/integrations";
import { provisionIntegrationUser } from "@/lib/services/provisioning";
import { getDeps } from "@/lib/session";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import { adresseAutorisee } from "./adresses";
import { verifierJeton } from "./jeton";

/**
 * API d'intégration `/api/v1` (spécification #71) : chaque appel porte un jeton d'intégration, passe les contrôles dans
 * l'ordre du contrat (intégration active, adresse, plafond, périmètre), provisionne le collaborateur au premier accès
 * (sauf identité incohérente),
 * puis appelle les mêmes services que les pages du portail, pour le collaborateur seul, jamais comme admin. Toutes les
 * réponses portent `Cache-Control: no-store` ; les erreurs ont un code stable et un message dans la langue demandée.
 */

/** Destinataire (`aud`) des jetons d'intégration : le portail, « ai-gateway » sauf réglage INTEGRATION_TOKEN_AUDIENCE. */
const AUDIENCE = process.env.INTEGRATION_TOKEN_AUDIENCE?.trim() || "ai-gateway";

/** En-tête où Caddy transmet l'adresse réelle du client ; il l'écrase lui-même (infra/caddy/portail.caddy). */
const ENTETE_ADRESSE = "x-real-ip";

/** Taille maximale du corps d'une requête : 16 Kio. */
const TAILLE_MAXIMALE_DU_CORPS = 16 * 1024;

/** Plafond de chaque intégration : fenêtre glissante d'une minute, en mémoire, commune à toutes les routes de l'API. */
const memoire = globalThis as typeof globalThis & { plafondsDesIntegrations?: LimiteDeDebit };
const plafonds = (memoire.plafondsDesIntegrations ??= new LimiteDeDebit(120, 60_000));

export type DepsApi = ReturnType<typeof getDeps>;

/** Traducteur des textes de l'API dans la langue demandée (dictionnaires du portail). */
export type Traducteur = (typeof TRADUCTEURS)[Langue];

/**
 * Ce que reçoit le traitement d'une route : le collaborateur du jeton, les dépendances, la langue et son traducteur, les
 * paramètres du chemin, et la lecture du corps JSON, contrôlé par un schéma (saisie invalide : 400).
 */
export interface Appel<P> {
  acteur: SessionUser;
  deps: DepsApi;
  langue: Langue;
  t: Traducteur;
  params: P;
  corps: <T>(schema: z.ZodType<T>) => Promise<T>;
}

/** Réponse d'une route autre que 200 : 201 avec l'identifiant de ce qu'elle crée, ou 204 sans corps. */
export class Reponse {
  constructor(
    readonly statut: 201 | 204,
    readonly corps?: unknown,
  ) {}
}

/** Refus de l'API : statut HTTP, code stable, détails, et attente avant de réessayer (429), en millisecondes. */
class RefusApi extends Error {
  constructor(
    readonly statut: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
    readonly attente?: number,
  ) {
    super(code);
  }
}

/** Statut HTTP des erreurs métier des services ; les autres sont des saisies refusées (400). */
const STATUTS: Partial<Record<PortalErrorCode, number>> = {
  interdit: 403,
  non_membre: 403,
  introuvable: 404,
  transition_interdite: 409,
  demande_en_cours: 409,
  deja_membre: 409,
  identite_incoherente: 409,
  renouvellement_trop_tot: 409,
  trop_de_generations: 429,
  passerelle_indisponible: 502,
};

/**
 * Route de l'API : `perimetre` est celui qu'elle exige de l'intégration (aucun pour le contrat). Le traitement rend le
 * corps de la réponse (200), ou une `Reponse` (201, 204).
 */
export function routeApi<P = Record<string, never>>(perimetre: Perimetre | null, traiter: (appel: Appel<P>) => Promise<unknown>) {
  return async (requete: Request, contexte: { params: Promise<P> }): Promise<Response> => {
    const langue = langueDemandee(undefined, requete.headers.get("accept-language"));
    try {
      const deps = getDeps();
      const acteur = await controler(requete, perimetre, deps, new Date());
      await provisionIntegrationUser(deps, acteur);
      const corps = async <T>(schema: z.ZodType<T>) => schema.parse(await lireJson(requete));
      const resultat = await traiter({ acteur, deps, langue, t: TRADUCTEURS[langue], params: await contexte.params, corps });
      if (!(resultat instanceof Reponse)) return json(200, resultat);
      return resultat.statut === 204 ? new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }) : json(201, resultat.corps);
    } catch (e) {
      return reponseErreur(versRefus(e), langue);
    }
  };
}

/** Corps JSON de la requête, lu jusqu'à 16 Kio au plus : au-delà, ou illisible, c'est une saisie invalide. */
async function lireJson(requete: Request): Promise<unknown> {
  const refus = (reason: "taille" | "json") => new RefusApi(400, "saisie_invalide", { fields: [], reason });
  if (Number(requete.headers.get("content-length") ?? 0) > TAILLE_MAXIMALE_DU_CORPS) throw refus("taille");
  const morceaux: Uint8Array[] = [];
  let taille = 0;
  const lecteur = requete.body?.getReader();
  for (let morceau = await lecteur?.read(); morceau && !morceau.done; morceau = await lecteur?.read()) {
    taille += morceau.value.byteLength;
    if (taille > TAILLE_MAXIMALE_DU_CORPS) {
      await lecteur?.cancel();
      throw refus("taille");
    }
    morceaux.push(morceau.value);
  }
  try {
    return JSON.parse(Buffer.concat(morceaux).toString("utf8"));
  } catch {
    throw refus("json");
  }
}

/** Route inconnue de l'API : après les contrôles de toute route (jeton, intégration, adresse, plafond), 404. */
export async function routeInconnue(requete: Request): Promise<Response> {
  const langue = langueDemandee(undefined, requete.headers.get("accept-language"));
  try {
    await controler(requete, null, getDeps(), new Date());
    throw new RefusApi(404, "introuvable", { objet: "route" });
  } catch (e) {
    return reponseErreur(versRefus(e), langue);
  }
}

/** Jeton, puis intégration active, adresse de l'appelant, plafond et périmètre : le collaborateur qui agit, ou le refus. */
async function controler(requete: Request, perimetre: Perimetre | null, deps: DepsApi, maintenant: Date): Promise<SessionUser> {
  const verification = await verifierJeton(requete.headers.get("authorization"), {
    emetteur: (id) => lireIntegrationAppelante(deps.db, id),
    audience: AUDIENCE,
    maintenant,
  });
  if (!verification.ok) {
    throw new RefusApi(401, "jeton_invalide", { reason: verification.motif, ...(verification.revendication ? { claim: verification.revendication } : {}) });
  }
  const integration = verification.emetteur;
  if (!integration.active) throw new RefusApi(503, "integration_inactive");
  if (!adresseAutorisee(requete.headers.get(ENTETE_ADRESSE), integration.ipRanges)) throw new RefusApi(403, "adresse_non_autorisee");
  if (!plafonds.autoriser(integration.id, maintenant, integration.rateLimitPerMinute)) {
    throw new RefusApi(429, "trop_de_requetes", {}, plafonds.attente(integration.id, maintenant, integration.rateLimitPerMinute));
  }
  if (perimetre && !integration.scopes.includes(perimetre)) throw new RefusApi(403, "hors_perimetre", { scope: perimetre });
  return verification.acteur;
}

/** Erreur → refus de l'API. Les erreurs de la passerelle ne sont jamais renvoyées telles quelles. */
function versRefus(e: unknown): RefusApi {
  if (e instanceof RefusApi) return e;
  if (e instanceof PolicyViolationError) return new RefusApi(400, e.code, { failedChecks: e.failedChecks.map(({ id, offending }) => ({ id, offending })) });
  if (e instanceof PortalError) return new RefusApi(STATUTS[e.code] ?? 400, e.code, e.params);
  if (e instanceof z.ZodError) {
    // Champs en cause, champs inconnus compris ; sans champ, c'est le corps entier qui n'est pas l'objet attendu.
    const chemins = e.issues.flatMap((i) => (i.code === "unrecognized_keys" ? i.keys.map((cle) => [...i.path, cle]) : [i.path]));
    const fields = [...new Set(chemins.map((chemin) => chemin.join(".")).filter(Boolean))];
    return new RefusApi(400, "saisie_invalide", fields.length > 0 ? { fields } : { fields, reason: "json" });
  }
  if (e instanceof LiteLLMError || (e instanceof TypeError && e.message === "fetch failed")) {
    console.error(`API d'intégration : passerelle indisponible (${e.message})`);
    return new RefusApi(502, "passerelle_indisponible");
  }
  console.error(`API d'intégration : erreur inattendue (${e instanceof Error ? e.message : "inconnue"})`);
  return new RefusApi(500, "erreur_interne");
}

function reponseErreur(refus: RefusApi, langue: Langue): Response {
  const entetes = refus.attente !== undefined ? { "Retry-After": String(Math.max(1, Math.ceil(refus.attente / 1000))) } : undefined;
  return json(refus.statut, { error: { code: refus.code, message: message(langue, refus), details: refus.details } }, entetes);
}

function json(statut: number, corps: unknown, entetes: Record<string, string> = {}): Response {
  return Response.json(corps, { status: statut, headers: { "Cache-Control": "no-store", ...entetes } });
}

/**
 * Textes de l'API, repris des dictionnaires du portail : erreurs (espaces « avis » et « api »), noms du domaine (niveaux,
 * statuts) et engagement de la demande de clé. Les codes d'erreur ne sont connus qu'à l'exécution : les clés ne sont
 * pas vérifiées à la compilation.
 */
const textes = (messages: typeof fr) => ({
  avis: messages.avis,
  api: messages.api,
  domaine: messages.domaine,
  nouvelleDemande: { engagement: messages.nouvelleDemande.engagement },
});
const TRADUCTEURS = {
  fr: createTranslator<Messages>({ locale: "fr", messages: textes(fr) }),
  en: createTranslator<Messages>({ locale: "en", messages: textes(en) }),
};

function message(langue: Langue, { code, details }: RefusApi): string {
  const t = TRADUCTEURS[langue];
  const cle = [`api.erreurs.${code}`, `avis.erreurs.${code}`].find((c) => t.has(c)) ?? "avis.erreurs.inconnue";
  const valeurs = Object.fromEntries(Object.entries(details).flatMap(([nom, valeur]) => (typeof valeur === "string" || typeof valeur === "number" ? [[nom, String(valeur)]] : [])));
  // Champs d'une saisie invalide et contrôles en échec, nommés comme dans le portail.
  const champs = [...new Set(((details.fields as string[] | undefined) ?? []).map((chemin) => chemin.split(".")[0]))]
    .map((champ) => (t.has(`avis.champs.${champ}`) ? t(`avis.champs.${champ}`) : champ))
    .join(", ");
  const controles = ((details.failedChecks as { id: string; offending: string[] }[] | undefined) ?? [])
    .map(({ id, offending }) => `${t.has(`avis.controles.${id}`) ? t(`avis.controles.${id}`) : id}${offending.length > 0 ? ` (${offending.join(", ")})` : ""}`)
    .join(" ; ");
  // Paramètres attendus par les messages (ICU) : une valeur vide choisit la variante par défaut.
  const defauts = { objet: "", cas: "", modele: "", equipe: "", champ: "", raison: "", valeur: "", id: "", kid: "", reason: "", claim: "", scope: "" };
  return t(cle, { ...defauts, ...valeurs, champs, controles });
}
