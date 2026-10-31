import { Bot, FilePen, Globe, type LucideIcon, SquareTerminal } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import type { Langue } from "@/lib/langue";
import { DATA_LEVELS, type DataLevel } from "@/lib/policy";
import { recommendedModels } from "@/lib/services/catalog";
import type { CleEcartee, IdentiteCle } from "@/lib/services/cles-assistants";
import { getDeps } from "@/lib/session";
import { BoutonCopier } from "../../bouton-copier";
import { PastillesClassification } from "../../pastilles-classification";

/*
 * Éléments communs aux tutoriels de configuration d'un assistant de code (OpenCode, Claude Code) à partir des clés
 * émises. Leurs textes communs sont dans l'espace de traduction « assistants » ; chaque tutoriel a le sien (`espace`) pour
 * les textes qui nomment son assistant : `titre`, `intro`, `endroits.assistant`, `etapeCles.rappel` et `sansCle.intro`.
 */

export type Parametres = Record<string, string | string[] | undefined>;

/** Espace de traduction d'un tutoriel. */
type Espace = "opencode" | "claudeCode";

/**
 * Endroits où agir dans le tutoriel, chacun avec son pictogramme (jeu Lucide) ; `assistant` est l'assistant configuré,
 * nommé dans l'espace du tutoriel.
 */
const ENDROITS = { terminal: SquareTerminal, navigateur: Globe, editeur: FilePen, assistant: Bot } satisfies Record<string, LucideIcon>;
export type Endroit = keyof typeof ENDROITS;

/** Niveaux qu'un dépôt peut avoir : le niveau Expérimental n'accepte que des données publiques, à part. */
const NIVEAUX_DU_CODE = ["N1", "N2", "N3"] as const;

/**
 * Demandes des clés choisies, d'après l'adresse : le formulaire envoie `choix` avec les clés cochées, même aucune ; le lien
 * d'une clé de « Mes clés » n'envoie que `cle` ; sans l'un ni l'autre, toutes les clés proposées sont choisies (null).
 */
export function demandesChoisies(parametres: Parametres): string[] | null {
  const cles = [parametres.cle ?? []].flat();
  return parametres.choix === undefined && cles.length === 0 ? null : cles;
}

/** Nom de chaque niveau de confidentialité, lu par le traducteur de l'espace « domaine ». */
export function nomsDesNiveaux(domaine: (cle: `niveaux.${DataLevel}`) => string): Record<DataLevel, string> {
  return Object.fromEntries(DATA_LEVELS.map((n) => [n, domaine(`niveaux.${n}`)])) as Record<DataLevel, string>;
}

/** Touche du clavier et extrait de code dans les textes du tutoriel. */
export const BALISES = {
  kbd: (texte: ReactNode) => <kbd className="rounded border border-neutral-400 px-1 text-xs">{texte}</kbd>,
  code: (texte: ReactNode) => <code>{texte}</code>,
};

/** Étape du tutoriel : son numéro, son titre et les endroits où agir, chacun avec son pictogramme. */
export async function Etape({
  espace,
  id,
  numero,
  titre,
  endroits,
  children,
}: {
  espace: Espace;
  id: string;
  numero: number;
  titre: string;
  endroits: Endroit[];
  children: ReactNode;
}) {
  const [t, commun] = await Promise.all([getTranslations(espace), getTranslations("assistants")]);
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-grid size-7 place-items-center rounded bg-linagora text-sm text-white">
          {numero}
        </span>
        {titre}
      </h2>
      <p className="mt-1 flex flex-wrap gap-2">
        {endroits.map((endroit) => {
          const Pictogramme = ENDROITS[endroit];
          return (
            <span key={endroit} className="inline-flex items-center gap-1 rounded-full border border-neutral-300 px-2 text-xs">
              <Pictogramme aria-hidden="true" className="size-3.5" />
              {endroit === "assistant" ? t("endroits.assistant") : commun(`endroits.${endroit}`)}
            </span>
          );
        })}
      </p>
      <div className="mt-2 flex max-w-prose flex-col gap-2">{children}</div>
    </section>
  );
}

/** Texte à copier, une commande par défaut : les textes plus longs ont leurs propres libellés. */
export async function ACopier({ texte, libelle, libelleCopie }: { texte: string; libelle?: string; libelleCopie?: string }) {
  const t = await getTranslations("assistants");
  return (
    <div>
      <pre className="max-h-[32rem] overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
        <code>{texte}</code>
      </pre>
      <BoutonCopier texte={texte} libelle={libelle ?? t("copierCommande")} libelleCopie={libelleCopie ?? t("commandeCopiee")} />
    </div>
  );
}

/** Clé désignée par son alias, son équipe et son niveau de confidentialité. */
export function IdentiteDeLaCle({ cle, niveau }: { cle: IdentiteCle; niveau: string }) {
  return (
    <>
      <code>{cle.alias}</code> · {cle.teamAlias} · {niveau}
    </>
  );
}

/** Rappel des niveaux de confidentialité qu'un dépôt de code peut avoir, avec les classifications de chacun. */
export async function RappelDesNiveaux({ espace, niveaux }: { espace: Espace; niveaux: Record<DataLevel, string> }) {
  const [t, commun] = await Promise.all([getTranslations(espace), getTranslations("assistants")]);
  return (
    <>
      <p>{t("etapeCles.rappel")}</p>
      <ul className="flex flex-col gap-2">
        {NIVEAUX_DU_CODE.map((niveau) => (
          <li key={niveau}>
            {commun("etapeCles.niveau", { niveau: niveaux[niveau], description: commun(`etapeCles.niveaux.${niveau}`) })}
            <PastillesClassification level={niveau} className="mt-1 flex flex-wrap gap-1" />
          </li>
        ))}
      </ul>
    </>
  );
}

/** Clés émises qui ne sont pas proposées, avec la raison ; rien quand toutes le sont. */
export async function ClesNonProposees({ clesEcartees, niveaux }: { clesEcartees: CleEcartee[]; niveaux: Record<DataLevel, string> }) {
  if (clesEcartees.length === 0) return null;
  const t = await getTranslations("assistants");
  return (
    <section aria-labelledby="cles-non-proposees" className="mt-6">
      <h3 id="cles-non-proposees" className="font-medium">
        {t("clesNonProposees")}
      </h3>
      <ul className="mt-2 list-disc pl-6 text-sm">
        {clesEcartees.map((cle) => (
          <li key={cle.requestId}>
            <IdentiteDeLaCle cle={cle} niveau={niveaux[cle.dataLevel]} /> ({t(`raisonsCle.${cle.raison}`)})
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Sans clé proposée : les étapes pour en obtenir une, et les modèles recommandés pour le code. */
export async function SansCle({ espace, langue, niveaux, children }: { espace: Espace; langue: Langue; niveaux: Record<DataLevel, string>; children?: ReactNode }) {
  const [t, commun, mesCles, recommandes] = await Promise.all([
    getTranslations(espace),
    getTranslations("assistants"),
    getTranslations("cles"),
    recommendedModels(getDeps(), "CODING", langue),
  ]);
  return (
    <>
      <h1>{t("titre")}</h1>
      <p className="max-w-prose">{t("intro")}</p>
      <p className="mt-4">{t("sansCle.intro")}</p>
      <ol className="mt-2 list-decimal pl-6">
        <li>
          {mesCles("etapes.equipe")} <Link href="/demandes/adhesion">{mesCles("etapes.equipeLien")}</Link>
        </li>
        <li>
          {mesCles("etapes.demande")} <Link href="/catalogue">{mesCles("catalogue")}</Link> · <Link href="/demandes/nouvelle">{mesCles("etapes.demandeLien")}</Link>
        </li>
        <li>
          {mesCles("etapes.examen")} <Link href="/demandes">{mesCles("etapes.examenLien")}</Link>
        </li>
        <li>{mesCles("etapes.retrait")}</li>
      </ol>
      <section aria-labelledby="recommandes" className="mt-6">
        <h2 id="recommandes">{commun("sansCle.recommandes")}</h2>
        {recommandes.length === 0 ? (
          <p className="mt-2">
            {commun("sansCle.aucunRecommande")} <Link href="/catalogue">{mesCles("catalogue")}</Link>
          </p>
        ) : (
          <ul className="mt-2 list-disc pl-6">
            {recommandes.map((m) => (
              <li key={m.modelName}>
                {m.displayName} · {niveaux[m.dataLevel]}
              </li>
            ))}
          </ul>
        )}
      </section>
      {children}
    </>
  );
}

/** La passerelle ne répond pas : la page n'a que son titre et l'alerte. */
export async function Indisponible({ espace }: { espace: Espace }) {
  const [t, commun] = await Promise.all([getTranslations(espace), getTranslations("assistants")]);
  return (
    <>
      <h1>{t("titre")}</h1>
      <p role="alert" className="mt-2 text-red-800">
        {commun("indisponible")}
      </p>
    </>
  );
}
