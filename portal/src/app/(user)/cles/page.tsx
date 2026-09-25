import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listMyKeys } from "@/lib/services/keys";
import { getDeps, requireUser } from "@/lib/session";
import { BoutonCopier } from "../../bouton-copier";
import { formats, Notice } from "../../components";
import { exemplesAppel, LANGAGES } from "../../exemples-appel";
import { RetraitCle } from "./retrait-cle";

/** Tickets #15 et suivants : les demandes approuvées à retirer, puis les clés émises du titulaire. */
export default async function MesClesPage(props: PageProps<"/cles">) {
  const user = await requireUser();
  const [{ date, euros }, t, domaine, detail, searchParams] = await Promise.all([
    formats(),
    getTranslations("cles"),
    getTranslations("domaine"),
    getTranslations("detail"),
    props.searchParams,
  ]);
  const { toPickUp, keys } = await listMyKeys(getDeps(), user);
  const textesExemple = { message: detail("exemple.message"), etat: detail("exemple.etat"), question: detail("exemple.question") };

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
                <RetraitCle requestId={d.requestId} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="emises">
        <h2 id="emises">{t("emises")}</h2>
        {keys.length === 0 ? (
          <p>
            {t("aucune")} <Link href="/catalogue">{t("catalogue")}</Link>
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {keys.map((k) => {
              const exemples = k.example ? exemplesAppel(k.example.model, k.example.apiKind, textesExemple) : null;
              return (
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
                      {k.usage?.blocked && ` · ${t("bloquee")}`}
                    </dd>
                    <dt className="font-medium">{t("colonnes.emise")}</dt>
                    <dd>{date(k.issuedAt)}</dd>
                    <dt className="font-medium">{t("colonnes.expiration")}</dt>
                    <dd>{k.expiresAt ? date(k.expiresAt) : "—"}</dd>
                    {k.usage && (
                      <>
                        <dt className="font-medium">{t("depense")}</dt>
                        <dd>
                          {k.usage.maxBudget !== null && (
                            <progress value={Math.min(k.usage.spend, k.usage.maxBudget)} max={k.usage.maxBudget} aria-hidden="true" className="mr-2 align-middle" />
                          )}
                          {t("depenseSur", {
                            depense: k.usage.spend > 0 && k.usage.spend < 0.01 ? t("moinsDunCentime") : euros(k.usage.spend),
                            budget: euros(k.usage.maxBudget),
                          })}
                        </dd>
                        {k.usage.budgetResetAt && (
                          <>
                            <dt className="font-medium">{t("remiseAZero")}</dt>
                            <dd>{date(k.usage.budgetResetAt)}</dd>
                          </>
                        )}
                      </>
                    )}
                  </dl>
                  {!k.usage && k.status === "CLE_EMISE" && <p className="mt-2 text-sm italic">{t("infoIndisponible")}</p>}
                  {exemples && k.status === "CLE_EMISE" && (
                    <details className="mt-3">
                      <summary className="cursor-pointer font-medium">{t("commentUtiliser")}</summary>
                      <p className="mt-2 text-sm">{t("emplacement")}</p>
                      {LANGAGES.map((langage) => (
                        <div key={langage} className="mt-3">
                          <h4 className="text-sm font-medium">{t(`langages.${langage}`)}</h4>
                          <pre className="overflow-x-auto rounded bg-neutral-900 p-3 text-xs text-neutral-100">
                            <code>{exemples[langage]}</code>
                          </pre>
                          <BoutonCopier texte={exemples[langage]} libelle={t("copierExemple")} libelleCopie={t("exempleCopie")} />
                        </div>
                      ))}
                    </details>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
