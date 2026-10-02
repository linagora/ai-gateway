import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { PortalError } from "@/lib/errors";
import { DATA_LEVELS, type DataLevel } from "@/lib/policy";
import { type ConfigurationOpenCode, configurationOpenCode } from "@/lib/services/opencode";
import { getDeps, requireUser } from "@/lib/session";
import { BoutonCopier } from "../../../bouton-copier";
import { adresseApi } from "../../../exemples-appel";
import { FiltrageAutomatique } from "../../../filtrage-automatique";

type Parametres = Record<string, string | string[] | undefined>;

/**
 * Clés choisies d'après l'adresse : le formulaire envoie `choix` avec les clés cochées, même aucune ; le lien d'une clé
 * de « Mes clés » n'envoie que `cle` ; sans l'un ni l'autre, toutes les clés proposées sont choisies (null).
 */
function clesChoisies(parametres: Parametres): string[] | null {
  const cles = [parametres.cle ?? []].flat();
  return parametres.choix === undefined && cles.length === 0 ? null : cles;
}

/** Ticket #113 : configuration d'OpenCode à partir des clés émises du collaborateur, sans que sa clé passe par le portail. */
export default async function ConfigurerOpenCodePage(props: PageProps<"/cles/opencode">) {
  const user = await requireUser();
  const [t, domaine, langue, parametres] = await Promise.all([getTranslations("opencode"), getTranslations("domaine"), getLocale(), props.searchParams]);
  const niveaux = Object.fromEntries(DATA_LEVELS.map((n) => [n, domaine(`niveaux.${n}`)])) as Record<DataLevel, string>;
  let resultat: ConfigurationOpenCode;
  try {
    resultat = await configurationOpenCode(getDeps(), user, {
      langue: langue === "en" ? "en" : "fr",
      adresseApi: adresseApi(),
      textes: { niveaux, invite: (cle) => t("invite", cle) },
      cles: clesChoisies(parametres),
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
  const { cles, clesEcartees, configuration, commandes, verification } = resultat;

  return (
    <>
      <h1>{t("titre")}</h1>
      <p className="max-w-prose">{t("intro")}</p>

      {cles.length === 0 ? (
        <p className="mt-4">
          {t("aucuneCle")} <Link href="/cles">{t("versMesCles")}</Link>
        </p>
      ) : (
        <form method="get" className="mt-4">
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
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <input type="hidden" name="choix" value="1" />
          <FiltrageAutomatique minimum={0} />
        </form>
      )}

      {clesEcartees.length > 0 && (
        <section aria-labelledby="cles-non-proposees" className="mt-6">
          <h2 id="cles-non-proposees">{t("clesNonProposees")}</h2>
          <ul className="mt-2 list-disc pl-6 text-sm">
            {clesEcartees.map((cle) => (
              <li key={cle.requestId}>
                <code>{cle.alias}</code> · {cle.teamAlias} · {niveaux[cle.dataLevel]} ({t(`raisonsCle.${cle.raison}`)})
              </li>
            ))}
          </ul>
        </section>
      )}

      {configuration === null || commandes === null ? (
        cles.length > 0 && <p className="mt-6">{t("aucuneChoisie")}</p>
      ) : (
        <>
          <section aria-labelledby="configuration" className="mt-6">
            <h2 id="configuration">{t("configuration")}</h2>
            <p className="text-sm">{t("configurationExplication")}</p>
            <p className="text-sm">{t("couts")}</p>
            <pre className="mt-2 max-h-[32rem] overflow-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
              <code>{configuration}</code>
            </pre>
            <BoutonCopier texte={configuration} libelle={t("copierConfiguration")} libelleCopie={t("configurationCopiee")} />
          </section>
          <section aria-labelledby="commandes" className="mt-6">
            <h2 id="commandes">{t("commandes")}</h2>
            <p className="text-sm">{t("commandesExplication")}</p>
            <pre className="mt-2 overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
              <code>{commandes}</code>
            </pre>
            <BoutonCopier texte={commandes} libelle={t("copierCommandes")} libelleCopie={t("commandesCopiees")} />
            <p className="mt-4 text-sm">{t("verification")}</p>
            <pre className="mt-2 overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
              <code>{verification}</code>
            </pre>
            <BoutonCopier texte={verification} libelle={t("copierVerification")} libelleCopie={t("verificationCopiee")} />
          </section>
        </>
      )}
    </>
  );
}
