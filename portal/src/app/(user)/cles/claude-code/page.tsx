import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { PortalError } from "@/lib/errors";
import type { Langue } from "@/lib/langue";
import { type ConfigurationClaudeCode, configurationClaudeCode } from "@/lib/services/claude-code";
import { getDeps, requireUser } from "@/lib/session";
import { adresseApi } from "../../../exemples-appel";
import { FiltrageAutomatique } from "../../../filtrage-automatique";
import { PastillesClassification } from "../../../pastilles-classification";
import { ACopier, BALISES, ClesNonProposees, demandesChoisies, Etape, IdentiteDeLaCle, Indisponible, nomsDesNiveaux, RappelDesNiveaux, SansCle } from "../tutoriel";

/** Espace de traduction de la page. */
const ESPACE = "claudeCode";

/** Commandes du tutoriel (Ubuntu), les mêmes dans toutes les langues. */
const INSTALLATION = "curl -fsSL https://claude.ai/install.sh | bash";
const VERSION = "claude --version";
const MISE_A_JOUR = "claude update";
const SECRET_TOOL = "sudo apt install libsecret-tools";

/** Configuration de Claude Code à partir des clés émises : un lanceur par clé, avec son tutoriel pour Ubuntu. */
export default async function ConfigurerClaudeCodePage(props: PageProps<"/cles/claude-code">) {
  const user = await requireUser();
  const [t, domaine, locale, parametres] = await Promise.all([getTranslations(ESPACE), getTranslations("domaine"), getLocale(), props.searchParams]);
  const langue: Langue = locale === "en" ? "en" : "fr";
  const niveaux = nomsDesNiveaux(domaine);
  let resultat: ConfigurationClaudeCode;
  try {
    resultat = await configurationClaudeCode(getDeps(), user, {
      langue,
      adresseApi: adresseApi(),
      textes: {
        niveaux,
        invite: (cle) => t("invite", cle),
        libelle: (cle) => t("libelle", cle),
        enTete: (cle) => t("script.enTete", cle),
        priorite: t("script.priorite"),
        trafic: t("script.trafic"),
        adresse: t("script.adresse"),
        introuvable: t("script.introuvable"),
        modeleUnique: t("script.modeleUnique"),
        autresModeles: (liste) => t("script.autresModeles", { liste }),
        contexte: t("script.contexte"),
        question: t("script.question"),
      },
      requestIds: demandesChoisies(parametres),
      modelesParDefaut: [parametres.modele ?? []].flat(),
    });
  } catch (e) {
    if (!(e instanceof PortalError && e.code === "passerelle_indisponible")) throw e;
    return <Indisponible espace={ESPACE} />;
  }
  const { cles, clesEcartees, commandes, lanceurs, verification } = resultat;

  const nonProposees = <ClesNonProposees espace={ESPACE} clesEcartees={clesEcartees} niveaux={niveaux} />;

  if (cles.length === 0) {
    return (
      <SansCle espace={ESPACE} langue={langue} niveaux={niveaux}>
        {nonProposees}
      </SansCle>
    );
  }

  // Exemples de l'étape « Utiliser » : le lanceur et le modèle par défaut de la première clé choisie.
  const exemple = cles.find((cle) => cle.choisie) ?? cles[0];
  const modeleExemple = exemple.modeles.find((m) => m.reference === exemple.modeleParDefaut) ?? exemple.modeles[0];

  return (
    <>
      <h1>{t("titre")}</h1>
      <p className="max-w-prose">{t("intro")}</p>

      <Etape espace={ESPACE} id="installer" numero={1} titre={t("etapeInstaller.titre")} endroits={["terminal"]}>
        <p>{t.rich("etapeInstaller.terminal", BALISES)}</p>
        <p>{t.rich("etapeInstaller.coller", BALISES)}</p>
        <p>{t("etapeInstaller.installer")}</p>
        <ACopier espace={ESPACE} texte={INSTALLATION} />
        <p>{t.rich("etapeInstaller.verifier", BALISES)}</p>
        <ACopier espace={ESPACE} texte={VERSION} />
        <p>{t("etapeInstaller.mettreAJour")}</p>
        <ACopier espace={ESPACE} texte={MISE_A_JOUR} />
        <p>{t.rich("etapeInstaller.secretTool", BALISES)}</p>
        <ACopier espace={ESPACE} texte={SECRET_TOOL} />
      </Etape>

      <Etape espace={ESPACE} id="cles" numero={2} titre={t("etapeCles.titre")} endroits={["navigateur"]}>
        <RappelDesNiveaux espace={ESPACE} niveaux={niveaux} />
        <p>{t("etapeCles.parDefaut")}</p>
        <form method="get" className="mt-2">
          <fieldset>
            <legend className="font-medium">{t("clesAInclure")}</legend>
            <ul className="mt-2 flex flex-col gap-3">
              {cles.map((cle) => (
                <li key={cle.requestId}>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" name="cle" value={cle.requestId} defaultChecked={cle.choisie} className="mt-1" />
                    <span>
                      <IdentiteDeLaCle cle={cle} niveau={niveaux[cle.dataLevel]} />
                      <span className="block text-sm">{t("modeles", { liste: cle.modeles.map((m) => m.displayName).join(", ") })}</span>
                      {cle.modelesEcartes.length > 0 && (
                        <span className="block text-sm text-neutral-600">
                          {t("modelesEcartes", { liste: cle.modelesEcartes.map((m) => `${m.modelName} (${t(`raisonsModele.${m.raison}`)})`).join(", ") })}
                        </span>
                      )}
                      <span className="block text-sm">{t.rich("lanceur", { ...BALISES, nom: cle.lanceur })}</span>
                      <PastillesClassification level={cle.dataLevel} className="mt-1 flex flex-wrap gap-1" />
                    </span>
                  </label>
                  {cle.choisie && (
                    <label className="mt-2 ml-6 flex flex-col gap-1">
                      <span className="font-medium">
                        {t("modeleParDefaut")}
                        <span className="sr-only"> {t("modeleParDefautDe", { alias: cle.alias })}</span>
                      </span>
                      <select name="modele" defaultValue={cle.modeleParDefaut} className="self-start">
                        {cle.modeles.map((m) => (
                          <option key={m.modelName} value={m.reference}>
                            {m.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </li>
              ))}
            </ul>
          </fieldset>
          <input type="hidden" name="choix" value="1" />
          <FiltrageAutomatique minimum={0} />
        </form>
        {nonProposees}
      </Etape>

      {commandes === null || lanceurs === null || verification === null ? (
        <p className="mt-8">{t("aucuneChoisie")}</p>
      ) : (
        <>
          <Etape espace={ESPACE} id="commandes" numero={3} titre={t("etapeCommandes.titre")} endroits={["terminal"]}>
            <p>{t("commandesExplication")}</p>
            <ACopier espace={ESPACE} texte={commandes} libelle={t("copierCommandes")} libelleCopie={t("commandesCopiees")} />
          </Etape>
          <Etape espace={ESPACE} id="lanceurs" numero={4} titre={t("etapeLanceurs.titre")} endroits={["terminal"]}>
            <p>{t.rich("lanceursExplication", BALISES)}</p>
            <ACopier espace={ESPACE} texte={lanceurs} libelle={t("copierLanceurs")} libelleCopie={t("lanceursCopies")} />
            <p>{t("verification")}</p>
            <ACopier espace={ESPACE} texte={verification} />
            <p className="text-sm">{t.rich("chemin", BALISES)}</p>
          </Etape>
        </>
      )}

      <Etape espace={ESPACE} id="utiliser" numero={5} titre={t("etapeUtiliser.titre")} endroits={["terminal", "assistant"]}>
        <ul className="list-disc pl-6">
          <li>{t.rich("etapeUtiliser.lancer", { ...BALISES, lanceur: exemple.lanceur })}</li>
          <li>{t.rich("etapeUtiliser.choisir", { ...BALISES, modele: modeleExemple.modelName })}</li>
          <li>{t.rich("etapeUtiliser.couts", { lien: (texte: ReactNode) => <Link href="/cles">{texte}</Link> })}</li>
          <li>{t("etapeUtiliser.compte")}</li>
        </ul>
      </Etape>
    </>
  );
}
