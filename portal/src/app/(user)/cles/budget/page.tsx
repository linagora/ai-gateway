import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { joursDePeriode } from "@/lib/durees";
import { plafondMinimalDeHausse } from "@/lib/policy";
import { budgetRaiseDraft } from "@/lib/services/budgets";
import { getDeps, requireUser } from "@/lib/session";
import { demanderBudgetAction } from "../../../actions";
import { ExplicationObligatoires, formats, Notice } from "../../../components";
import { Obligatoire } from "../../../obligatoire";

/** Hausse du budget d'une clé émise (?cle=<demande de la clé>), ou complément d'une demande renvoyée (?completer=<id>). */
export default async function DemandeBudgetPage(props: PageProps<"/cles/budget">) {
  const user = await requireUser();
  const [{ date, euros }, t, searchParams] = await Promise.all([formats(), getTranslations("demandeBudget"), props.searchParams]);
  const parametre = (nom: string) => (typeof searchParams[nom] === "string" ? searchParams[nom] : "");
  const completing = parametre("completer");
  const brouillon = await budgetRaiseDraft(getDeps(), user, completing ? { completing } : { keyRequestId: parametre("cle") });
  if (!brouillon) {
    return (
      <>
        <h1>{t("titreGenerique")}</h1>
        <Notice searchParams={searchParams} />
        <p>
          {t("introuvable")} <Link href="/cles">{t("retour")}</Link>
        </p>
      </>
    );
  }

  const { currentBudget, budgetDuration } = brouillon;
  const jours = budgetDuration ? joursDePeriode(budgetDuration) : null;
  const plafond =
    currentBudget === null
      ? t("sansPlafond")
      : jours !== null
        ? t("plafondJours", { montant: euros(currentBudget), nombre: jours })
        : budgetDuration
          ? t("plafondPeriode", { montant: euros(currentBudget), periode: budgetDuration })
          : euros(currentBudget);
  return (
    <>
      <h1>{t(completing ? "titreCompleter" : "titre", { alias: brouillon.alias })}</h1>
      <Notice searchParams={searchParams} />
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 text-sm">
        <dt className="font-medium">{t("cle")}</dt>
        <dd>
          <code>{brouillon.alias}</code>
        </dd>
        <dt className="font-medium">{t("plafond")}</dt>
        <dd>{plafond}</dd>
        {brouillon.spend !== null && (
          <>
            <dt className="font-medium">{t("depense")}</dt>
            <dd>{euros(brouillon.spend)}</dd>
          </>
        )}
        {brouillon.budgetResetAt && (
          <>
            <dt className="font-medium">{t("remiseAZero")}</dt>
            <dd>{date(brouillon.budgetResetAt)}</dd>
          </>
        )}
      </dl>
      <form action={demanderBudgetAction}>
        <input type="hidden" name="keyRequestId" value={brouillon.keyRequestId} />
        {completing && <input type="hidden" name="requestId" value={completing} />}
        <ExplicationObligatoires />
        <label>
          {t("nouveauBudget")}
          <Obligatoire />
          <input type="number" name="requestedBudget" min={plafondMinimalDeHausse(currentBudget)} step="0.01" required defaultValue={brouillon.requestedBudget ?? ""} />
        </label>
        <p className="text-sm text-neutral-600">{t("aideMontant")}</p>
        <label>
          {t("justification")}
          <Obligatoire />
          <textarea name="justification" required rows={3} defaultValue={brouillon.justification ?? ""} />
        </label>
        <button type="submit">{completing ? t("resoumettre") : t("envoyer")}</button>
      </form>
    </>
  );
}
