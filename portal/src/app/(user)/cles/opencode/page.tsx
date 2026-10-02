import { Bot, FilePen, Globe, type LucideIcon, SquareTerminal } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import { DATA_LEVELS, type DataLevel } from "@/lib/policy";
import { recommendedModels } from "@/lib/services/catalog";
import { type ConfigurationOpenCode, configurationOpenCode, MISES_A_JOUR, type MiseAJour } from "@/lib/services/opencode";
import { getDeps, requireUser } from "@/lib/session";
import { BoutonCopier } from "../../../bouton-copier";
import { adresseApi } from "../../../exemples-appel";
import { FiltrageAutomatique } from "../../../filtrage-automatique";
import { PastillesClassification } from "../../../pastilles-classification";

type Parametres = Record<string, string | string[] | undefined>;

/** Commandes du tutoriel (Ubuntu), les mêmes dans toutes les langues. */
const INSTALLATION = "curl -fsSL https://opencode.ai/v2/install | bash";
const VERSION = "opencode --version";
const MISE_A_JOUR = "opencode upgrade";
const OUVERTURE = "mkdir -p ~/.config/opencode && gedit ~/.config/opencode/opencode.json";

/** Où agir à chaque étape du tutoriel, avec son pictogramme (jeu Lucide). */
const OU = { terminal: SquareTerminal, navigateur: Globe, editeur: FilePen, opencode: Bot } satisfies Record<string, LucideIcon>;
type Ou = keyof typeof OU;

/** Niveaux qu'un dépôt peut avoir : le niveau Expérimental n'accepte que des données publiques, à part. */
const NIVEAUX_DU_CODE = ["N1", "N2", "N3"] as const;

/**
 * Clés choisies d'après l'adresse : le formulaire envoie `choix` avec les clés cochées, même aucune ; le lien d'une clé
 * de « Mes clés » n'envoie que `cle` ; sans l'un ni l'autre, toutes les clés proposées sont choisies (null).
 */
function clesChoisies(parametres: Parametres): string[] | null {
  const cles = [parametres.cle ?? []].flat();
  return parametres.choix === undefined && cles.length === 0 ? null : cles;
}

/** Politique de mise à jour d'après l'adresse ; null si elle est absente ou inconnue. */
function miseAJour(parametres: Parametres): MiseAJour | null {
  return MISES_A_JOUR.find((m) => m === parametres.maj) ?? null;
}

/** Touche du clavier et extrait de code dans les textes du tutoriel. */
const BALISES = {
  kbd: (texte: ReactNode) => <kbd className="rounded border border-neutral-400 px-1 text-xs">{texte}</kbd>,
  code: (texte: ReactNode) => <code>{texte}</code>,
};

/** Étape du tutoriel : son numéro, son titre et où agir, chaque endroit avec son pictogramme. */
async function Etape({ id, numero, titre, ou, children }: { id: string; numero: number; titre: string; ou: Ou[]; children: ReactNode }) {
  const t = await getTranslations("opencode");
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="flex items-center gap-2">
        <span aria-hidden="true" className="inline-grid size-7 place-items-center rounded bg-linagora text-sm text-white">
          {numero}
        </span>
        {titre}
      </h2>
      <p className="mt-1 flex flex-wrap gap-2">
        {ou.map((endroit) => {
          const Pictogramme = OU[endroit];
          return (
            <span key={endroit} className="inline-flex items-center gap-1 rounded-full border border-neutral-300 px-2 text-xs">
              <Pictogramme aria-hidden="true" className="size-3.5" />
              {t(`ou.${endroit}`)}
            </span>
          );
        })}
      </p>
      <div className="mt-2 flex max-w-prose flex-col gap-2">{children}</div>
    </section>
  );
}

/** Commande à copier dans le terminal. */
async function Commande({ texte }: { texte: string }) {
  const t = await getTranslations("opencode");
  return (
    <div>
      <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
        <code>{texte}</code>
      </pre>
      <BoutonCopier texte={texte} libelle={t("copierCommande")} libelleCopie={t("commandeCopiee")} />
    </div>
  );
}

/** Ticket #113 et suivants : configuration d'OpenCode à partir des clés émises, avec son tutoriel pour Ubuntu (#117). */
export default async function ConfigurerOpenCodePage(props: PageProps<"/cles/opencode">) {
  const user = await requireUser();
  const [t, domaine, mesCles, locale, parametres] = await Promise.all([
    getTranslations("opencode"),
    getTranslations("domaine"),
    getTranslations("cles"),
    getLocale(),
    props.searchParams,
  ]);
  const langue: Langue = locale === "en" ? "en" : "fr";
  const niveaux = Object.fromEntries(DATA_LEVELS.map((n) => [n, domaine(`niveaux.${n}`)])) as Record<DataLevel, string>;
  let resultat: ConfigurationOpenCode;
  try {
    resultat = await configurationOpenCode(getDeps(), user, {
      langue,
      adresseApi: adresseApi(),
      textes: { niveaux, invite: (cle) => t("invite", cle) },
      cles: clesChoisies(parametres),
      modeleParDefaut: typeof parametres.modele === "string" ? parametres.modele : null,
      miseAJour: miseAJour(parametres),
    });
  } catch (e) {
    if (!(e instanceof PortalError && e.code === "passerelle_indisponible")) throw e;
    return (
      <>
        <h1>{t("titre")}</h1>
        <p role="alert" className="mt-2 text-red-800">
          {t("indisponible")}
        </p>
      </>
    );
  }
  const { cles, clesEcartees, modeleParDefaut, configuration, commandes, verification } = resultat;

  const nonProposees = clesEcartees.length > 0 && (
    <section aria-labelledby="cles-non-proposees" className="mt-6">
      <h3 id="cles-non-proposees" className="font-medium">
        {t("clesNonProposees")}
      </h3>
      <ul className="mt-2 list-disc pl-6 text-sm">
        {clesEcartees.map((cle) => (
          <li key={cle.requestId}>
            <code>{cle.alias}</code> · {cle.teamAlias} · {niveaux[cle.dataLevel]} ({t(`raisonsCle.${cle.raison}`)})
          </li>
        ))}
      </ul>
    </section>
  );

  if (cles.length === 0) {
    const recommandes = await recommendedModels(getDeps(), "CODING", langue);
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
          <h2 id="recommandes">{t("sansCle.recommandes")}</h2>
          {recommandes.length === 0 ? (
            <p className="mt-2">
              {t("sansCle.aucunRecommande")} <Link href="/catalogue">{mesCles("catalogue")}</Link>
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
        {nonProposees}
      </>
    );
  }

  return (
    <>
      <h1>{t("titre")}</h1>
      <p className="max-w-prose">{t("intro")}</p>

      <Etape id="installer" numero={1} titre={t("etapeInstaller.titre")} ou={["terminal"]}>
        <p>{t.rich("etapeInstaller.terminal", BALISES)}</p>
        <p>{t.rich("etapeInstaller.coller", BALISES)}</p>
        <p>{t("etapeInstaller.installer")}</p>
        <Commande texte={INSTALLATION} />
        <p>{t.rich("etapeInstaller.verifier", BALISES)}</p>
        <Commande texte={VERSION} />
        <p>{t("etapeInstaller.mettreAJour")}</p>
        <Commande texte={MISE_A_JOUR} />
      </Etape>

      <Etape id="cles" numero={2} titre={t("etapeCles.titre")} ou={["navigateur"]}>
        <p>{t("etapeCles.rappel")}</p>
        <ul className="flex flex-col gap-2">
          {NIVEAUX_DU_CODE.map((niveau) => (
            <li key={niveau}>
              {t("etapeCles.niveau", { niveau: niveaux[niveau], description: t(`etapeCles.niveaux.${niveau}`) })}
              <PastillesClassification level={niveau} className="mt-1 flex flex-wrap gap-1" />
            </li>
          ))}
        </ul>
        <form method="get" className="mt-2">
          <fieldset>
            <legend className="font-medium">{t("clesAInclure")}</legend>
            <ul className="mt-2 flex flex-col gap-3">
              {cles.map((cle) => (
                <li key={cle.requestId}>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" name="cle" value={cle.requestId} defaultChecked={cle.choisie} className="mt-1" />
                    <span>
                      <code>{cle.alias}</code> · {cle.teamAlias} · {niveaux[cle.dataLevel]}
                      <span className="block text-sm">{t("modeles", { liste: cle.modeles.map((m) => m.displayName).join(", ") })}</span>
                      {cle.modelesEcartes.length > 0 && (
                        <span className="block text-sm text-neutral-600">
                          {t("modelesEcartes", { liste: cle.modelesEcartes.map((m) => `${m.modelName} (${t(`raisonsModele.${m.raison}`)})`).join(", ") })}
                        </span>
                      )}
                      <PastillesClassification level={cle.dataLevel} className="mt-1 flex flex-wrap gap-1" />
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="mt-4 flex flex-wrap gap-6">
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t("modeleParDefaut")}</span>
              <select name="modele" defaultValue={modeleParDefaut ?? ""}>
                <option value="">{t("aucunModeleParDefaut")}</option>
                {cles
                  .filter((cle) => cle.choisie)
                  .map((cle) => (
                    <optgroup key={cle.requestId} label={`${cle.alias} · ${cle.teamAlias} · ${niveaux[cle.dataLevel]}`}>
                      {cle.modeles.map((m) => (
                        <option key={m.modelName} value={`${cle.entree}/${m.modelName}`}>
                          {m.displayName}
                        </option>
                      ))}
                    </optgroup>
                  ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-medium">{t("miseAJour")}</span>
              <select name="maj" defaultValue={miseAJour(parametres) ?? ""}>
                <option value="">{t("misesAJour.aucune")}</option>
                {MISES_A_JOUR.map((m) => (
                  <option key={m} value={m}>
                    {t(`misesAJour.${m}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <input type="hidden" name="choix" value="1" />
          <FiltrageAutomatique minimum={0} />
        </form>
        {nonProposees}
      </Etape>

      {configuration === null || commandes === null ? (
        <p className="mt-8">{t("aucuneChoisie")}</p>
      ) : (
        <>
          <Etape id="configuration" numero={3} titre={t("etapeConfiguration.titre")} ou={["terminal", "editeur"]}>
            <p>{t("etapeConfiguration.ouvrir")}</p>
            <Commande texte={OUVERTURE} />
            <p className="text-sm">{t.rich("etapeConfiguration.gedit", BALISES)}</p>
            <p>{t.rich("etapeConfiguration.coller", BALISES)}</p>
            <p className="text-sm">{t.rich("etapeConfiguration.existant", BALISES)}</p>
            <p className="text-sm">{t("couts")}</p>
            <div>
              <pre className="max-h-[32rem] overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
                <code>{configuration}</code>
              </pre>
              <BoutonCopier texte={configuration} libelle={t("copierConfiguration")} libelleCopie={t("configurationCopiee")} />
            </div>
          </Etape>
          <Etape id="commandes" numero={4} titre={t("etapeCommandes.titre")} ou={["terminal"]}>
            <p>{t("commandesExplication")}</p>
            <div>
              <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
                <code>{commandes}</code>
              </pre>
              <BoutonCopier texte={commandes} libelle={t("copierCommandes")} libelleCopie={t("commandesCopiees")} />
            </div>
            <p>{t("verification")}</p>
            <Commande texte={verification} />
          </Etape>
        </>
      )}

      <Etape id="utiliser" numero={5} titre={t("etapeUtiliser.titre")} ou={["terminal", "opencode"]}>
        <ul className="list-disc pl-6">
          <li>{t.rich("etapeUtiliser.lancer", BALISES)}</li>
          <li>{t.rich("etapeUtiliser.choisir", BALISES)}</li>
          <li>{t.rich("etapeUtiliser.favori", BALISES)}</li>
          <li>{t.rich("etapeUtiliser.changer", BALISES)}</li>
        </ul>
      </Etape>
    </>
  );
}
