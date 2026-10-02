import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listMyKeys } from "@/lib/services/keys";
import { getDeps, requireUser } from "@/lib/session";
import { BoutonCopier } from "../../bouton-copier";
import { remplacerCleAction, retirerCleAction, revoquerCleAction } from "../../actions";
import { DepenseSurBudget, formats, Notice } from "../../components";
import { adresseApi, exemplesAppel, LANGAGES } from "../../exemples-appel";
import { GenerationCle } from "./generation-cle";

/** Tickets #15 et suivants : les demandes approuvées à retirer, puis les clés émises du titulaire. */
export default async function MesClesPage(props: PageProps<"/cles">) {
  const user = await requireUser();
  const [{ date }, t, domaine, detail, searchParams] = await Promise.all([
    formats(),
    getTranslations("cles"),
    getTranslations("domaine"),
    getTranslations("detail"),
    props.searchParams,
  ]);
  const { toPickUp, keys } = await listMyKeys(getDeps(), user);
  const textesExemple = { message: detail("exemple.message"), etat: detail("exemple.etat"), question: detail("exemple.question"), image: detail("exemple.image") };

  return (
    <>
      <h1>{t("titre")}</h1>
      <Notice searchParams={searchParams} />
      {toPickUp.length > 0 && (
        <section aria-labelledby="a-retirer">
          <h2 id="a-retirer">{t("aRetirer")}</h2>
          <p>{t("aRetirerIntro")}</p>
          <ul className="mt-2 flex flex-col gap-4">
            {toPickUp.map((d) => (
              <li key={d.requestId} className="rounded border border-neutral-300 p-4">
                <p className="font-medium">
                  {d.teamAlias} · {domaine(`niveaux.${d.dataLevel}`)}
                  {d.project && ` · ${d.project}`}
                </p>
                <p className="text-sm">{d.models.join(", ")}</p>
                <p className="text-sm">{d.pickupDeadline ? t("echeance", { date: date(d.pickupDeadline) }) : t("sansEcheance")}</p>
                <GenerationCle requestId={d.requestId} action={retirerCleAction} libelle={t("generer")} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="emises">
        <h2 id="emises">{t("emises")}</h2>
        {keys.length === 0 && toPickUp.length > 0 ? (
          <p>{t("aucuneEmise")}</p>
        ) : keys.length === 0 ? (
          <>
            <p>{t("aucune")}</p>
            <ol className="mt-2 list-decimal pl-6">
              <li>
                {t("etapes.equipe")} <Link href="/demandes/adhesion">{t("etapes.equipeLien")}</Link>
              </li>
              <li>
                {t("etapes.demande")} <Link href="/catalogue">{t("catalogue")}</Link> · <Link href="/demandes/nouvelle">{t("etapes.demandeLien")}</Link>
              </li>
              <li>
                {t("etapes.examen")} <Link href="/demandes">{t("etapes.examenLien")}</Link>
              </li>
              <li>{t("etapes.retrait")}</li>
            </ol>
          </>
        ) : (
          <div className="flex flex-col gap-4">
            {keys.map((k) => (
              <article key={k.requestId} aria-labelledby={`cle-emise-${k.requestId}`} className="rounded border border-neutral-300 p-4">
                <h3 id={`cle-emise-${k.requestId}`} className="font-medium">
                  <code>{k.alias}</code>
                </h3>
                <p className="text-sm">
                  {k.teamAlias} · {domaine(`niveaux.${k.dataLevel}`)} · {k.models.join(", ")}
                </p>
                <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 text-sm">
                  <dt className="font-medium">{t("colonnes.statut")}</dt>
                  <dd>
                    {domaine(`statuts.${k.status}`)}
                    {k.gatewayState?.blocked && ` · ${t("bloquee")}`}
                  </dd>
                  <dt className="font-medium">{t("colonnes.emise")}</dt>
                  <dd>{date(k.issuedAt)}</dd>
                  {k.status === "CLE_EMISE" && (
                    <>
                      <dt className="font-medium">{t("adresseApi")}</dt>
                      <dd className="flex flex-wrap items-center gap-2">
                        <code className="break-all">{adresseApi()}</code>
                        <BoutonCopier texte={adresseApi()} libelle={t("copierAdresse")} libelleCopie={t("adresseCopiee")} className="mt-0 py-0.5 text-sm" />
                      </dd>
                    </>
                  )}
                  <dt className="font-medium">{t("colonnes.expiration")}</dt>
                  <dd>{k.expiresAt ? date(k.expiresAt) : domaine("durees.0")}</dd>
                  {k.gatewayState && (
                    <>
                      <dt className="font-medium">{t("depense")}</dt>
                      <dd>
                        {k.gatewayState.maxBudget !== null && (
                          <progress
                            value={Math.min(k.gatewayState.spend, k.gatewayState.maxBudget)}
                            max={k.gatewayState.maxBudget}
                            aria-hidden="true"
                            className="mr-2 align-middle"
                          />
                        )}
                        <DepenseSurBudget spend={k.gatewayState.spend} maxBudget={k.gatewayState.maxBudget} />
                      </dd>
                      {k.gatewayState.budgetResetAt && (
                        <>
                          <dt className="font-medium">{t("remiseAZero")}</dt>
                          <dd>{date(k.gatewayState.budgetResetAt)}</dd>
                        </>
                      )}
                    </>
                  )}
                </dl>
                {!k.gatewayState && k.status === "CLE_EMISE" && <p className="mt-2 text-sm italic">{t("infoIndisponible")}</p>}
                {(k.status === "CLE_EMISE" || k.status === "EXPIREE" || k.status === "REVOQUEE") && (
                  <p className="mt-2">
                    <Link href={`/demandes/nouvelle?renouvelle=${k.requestId}`}>{t("renouveler")}</Link>
                  </p>
                )}
                {k.status === "CLE_EMISE" && !k.gatewayState?.blocked && (
                  <details className="mt-3">
                    <summary className="cursor-pointer font-medium">{t("remplacer")}</summary>
                    <p className="mt-2 text-sm">{t("remplacementExplication")}</p>
                    <GenerationCle requestId={k.requestId} action={remplacerCleAction} libelle={t("confirmerRemplacement")} />
                  </details>
                )}
                {k.status === "CLE_EMISE" && (
                  <details className="mt-3">
                    <summary className="cursor-pointer font-medium">{t("revoquer")}</summary>
                    <p className="mt-2 text-sm">{t("revocationAvertissement")}</p>
                    <form action={revoquerCleAction}>
                      <input type="hidden" name="id" value={k.requestId} />
                      <button type="submit">{t("confirmerRevocation")}</button>
                    </form>
                  </details>
                )}
                {k.examples.length > 0 && k.status === "CLE_EMISE" && (
                  <details className="mt-3">
                    <summary className="cursor-pointer font-medium">{t("commentUtiliser")}</summary>
                    <p className="mt-2 text-sm">{t("emplacement")}</p>
                    {k.examples.some((e) => e.apiKind === "conversation") && (
                      <p className="mt-2 text-sm">
                        <Link href={`/cles/opencode?cle=${k.requestId}`}>{t("configurerOpenCode")}</Link>
                      </p>
                    )}
                    {k.examples.map(({ model, apiKind }) => {
                      const exemples = exemplesAppel(model, apiKind, textesExemple);
                      return (
                        <div key={model}>
                          <h4 className="mt-3 font-medium">{t("exemplesPour", { modele: model })}</h4>
                          {LANGAGES.map((langage) => (
                            <div key={langage} className="mt-2">
                              <h5 className="text-sm font-medium">{t(`langages.${langage}`)}</h5>
                              <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
                                <code>{exemples[langage]}</code>
                              </pre>
                              <BoutonCopier texte={exemples[langage]} libelle={t("copierExemple")} libelleCopie={t("exempleCopie")} />
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </details>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
