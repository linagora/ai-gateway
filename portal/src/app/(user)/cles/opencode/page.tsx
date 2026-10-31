import { getLocale, getTranslations } from "next-intl/server";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import { textesDesCles } from "@/lib/services/cles-assistants";
import { type ConfigurationOpenCode, configurationOpenCode, MISES_A_JOUR, type MiseAJour } from "@/lib/services/opencode";
import { getDeps, requireUser } from "@/lib/session";
import { adresseApi } from "../../../exemples-appel";
import { FiltrageAutomatique } from "../../../filtrage-automatique";
import { PastillesClassification } from "../../../pastilles-classification";
import { ACopier, BALISES, ClesNonProposees, demandesChoisies, Etape, IdentiteDeLaCle, Indisponible, nomsDesNiveaux, type Parametres, RappelDesNiveaux, SansCle } from "../tutoriel";

/** Espace de traduction de la page. */
const ESPACE = "opencode";

/** Commandes du tutoriel (Ubuntu), les mêmes dans toutes les langues. */
const INSTALLATION = "curl -fsSL https://opencode.ai/v2/install | bash";
const VERSION = "opencode --version";
const MISE_A_JOUR = "opencode upgrade";
const OUVERTURE = "mkdir -p ~/.config/opencode && gedit ~/.config/opencode/opencode.json";

/** Politique de mise à jour d'après l'adresse ; null si elle est absente ou inconnue. */
function miseAJour(parametres: Parametres): MiseAJour | null {
  return MISES_A_JOUR.find((m) => m === parametres.maj) ?? null;
}

/** Ticket #113 et suivants : configuration d'OpenCode à partir des clés émises, avec son tutoriel pour Ubuntu (#117). */
export default async function ConfigurerOpenCodePage(props: PageProps<"/cles/opencode">) {
  const user = await requireUser();
  const [t, commun, domaine, locale, parametres] = await Promise.all([
    getTranslations(ESPACE),
    getTranslations("assistants"),
    getTranslations("domaine"),
    getLocale(),
    props.searchParams,
  ]);
  const langue: Langue = locale === "en" ? "en" : "fr";
  const niveaux = nomsDesNiveaux(domaine);
  let resultat: ConfigurationOpenCode;
  try {
    resultat = await configurationOpenCode(getDeps(), user, {
      langue,
      adresseApi: adresseApi(),
      textes: textesDesCles(commun, niveaux),
      requestIds: demandesChoisies(parametres),
      modeleParDefaut: typeof parametres.modele === "string" ? parametres.modele : null,
      miseAJour: miseAJour(parametres),
    });
  } catch (e) {
    if (!(e instanceof PortalError && e.code === "passerelle_indisponible")) throw e;
    return <Indisponible espace={ESPACE} />;
  }
  const { cles, clesEcartees, modeleParDefaut, configuration, commandes, verification } = resultat;

  const nonProposees = <ClesNonProposees clesEcartees={clesEcartees} niveaux={niveaux} />;

  if (cles.length === 0) {
    return (
      <SansCle espace={ESPACE} langue={langue} niveaux={niveaux}>
        {nonProposees}
      </SansCle>
    );
  }

  return (
    <>
      <h1>{t("titre")}</h1>
      <p className="max-w-prose">{t("intro")}</p>

      <Etape espace={ESPACE} id="installer" numero={1} titre={t("etapeInstaller.titre")} endroits={["terminal"]}>
        <p>{commun.rich("etapeInstaller.terminal", BALISES)}</p>
        <p>{commun.rich("etapeInstaller.coller", BALISES)}</p>
        <p>{t("etapeInstaller.installer")}</p>
        <ACopier texte={INSTALLATION} />
        <p>{t.rich("etapeInstaller.verifier", BALISES)}</p>
        <ACopier texte={VERSION} />
        <p>{t("etapeInstaller.mettreAJour")}</p>
        <ACopier texte={MISE_A_JOUR} />
      </Etape>

      <Etape espace={ESPACE} id="cles" numero={2} titre={commun("etapeCles.titre")} endroits={["navigateur"]}>
        <RappelDesNiveaux espace={ESPACE} niveaux={niveaux} />
        <form method="get" className="mt-2">
          <fieldset>
            <legend className="font-medium">{commun("clesAInclure")}</legend>
            <ul className="mt-2 flex flex-col gap-3">
              {cles.map((cle) => (
                <li key={cle.requestId}>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" name="cle" value={cle.requestId} defaultChecked={cle.choisie} className="mt-1" />
                    <span>
                      <IdentiteDeLaCle cle={cle} niveau={niveaux[cle.dataLevel]} />
                      <span className="block text-sm">{commun("modeles", { liste: cle.modeles.map((m) => m.displayName).join(", ") })}</span>
                      {cle.modelesEcartes.length > 0 && (
                        <span className="block text-sm text-neutral-600">
                          {commun("modelesEcartes", {
                            liste: cle.modelesEcartes.map((m) => `${m.modelName} (${commun(`raisonsModele.${m.raison}`)})`).join(", "),
                          })}
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
              <span className="font-medium">{commun("modeleParDefaut")}</span>
              <select name="modele" defaultValue={modeleParDefaut ?? ""}>
                <option value="">{t("aucunModeleParDefaut")}</option>
                {cles
                  .filter((cle) => cle.choisie)
                  .map((cle) => (
                    <optgroup key={cle.requestId} label={`${cle.alias} · ${cle.teamAlias} · ${niveaux[cle.dataLevel]}`}>
                      {cle.modeles.map((m) => (
                        <option key={m.modelName} value={m.reference}>
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
          <Etape espace={ESPACE} id="configuration" numero={3} titre={t("etapeConfiguration.titre")} endroits={["terminal", "editeur"]}>
            <p>{t("etapeConfiguration.ouvrir")}</p>
            <ACopier texte={OUVERTURE} />
            <p className="text-sm">{t.rich("etapeConfiguration.gedit", BALISES)}</p>
            <p>{t.rich("etapeConfiguration.coller", BALISES)}</p>
            <p className="text-sm">{t.rich("etapeConfiguration.existant", BALISES)}</p>
            <p className="text-sm">{t("couts")}</p>
            <ACopier texte={configuration} libelle={t("copierConfiguration")} libelleCopie={t("configurationCopiee")} />
          </Etape>
          <Etape espace={ESPACE} id="commandes" numero={4} titre={t("etapeCommandes.titre")} endroits={["terminal"]}>
            <p>{t("commandesExplication")}</p>
            <ACopier texte={commandes} libelle={commun("copierCommandes")} libelleCopie={commun("commandesCopiees")} />
            <p>{t("verification")}</p>
            <ACopier texte={verification} />
          </Etape>
        </>
      )}

      <Etape espace={ESPACE} id="utiliser" numero={5} titre={t("etapeUtiliser.titre")} endroits={["terminal", "assistant"]}>
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
