import { Download, FileSpreadsheet } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { listChargesToReimburse, listTransmissions } from "@/lib/services/remboursements";
import { getDeps, requireAdminPage } from "@/lib/session";
import { transmettreRemboursementsAction } from "../../../actions";
import { formats, Notice } from "../../../components";
import { AdminNav } from "../admin-nav";
import { BoutonImprimer } from "./bouton-imprimer";
import { GroupeCollaborateur } from "./groupe-collaborateur";

/**
 * Remboursements (retours de l'utilisateur du 2026-09-26), réservés aux admins : les prélèvements des abonnements qui
 * restent à transmettre à la comptabilité jusqu'à la fin du mois choisi (par défaut le mois écoulé), retards compris,
 * par collaborateur avec leurs totaux HT et TTC, le détail de chacun se dépliant d'un chevron ; la liste s'exporte en
 * Excel ou s'imprime (ou s'enregistre en PDF) sans rien transmettre. « Marquer comme transmis » enregistre exactement la
 * liste affichée ; l'historique des transmissions donne le fichier CSV de chacune, pour la comptabilité.
 */
export default async function RemboursementsPage(props: PageProps<"/gestion/remboursements">) {
  const acteur = await requireAdminPage();
  const [t, { date, euros, jour }, format, searchParams] = await Promise.all([
    getTranslations("gestion.remboursements"),
    formats(),
    getFormatter(),
    props.searchParams,
  ]);
  const maintenant = new Date();
  const moisCourant = maintenant.toISOString().slice(0, 7);
  const moisEcoule = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const demande = typeof searchParams.mois === "string" ? searchParams.mois : "";
  const mois = /^\d{4}-(0[1-9]|1[0-2])$/.test(demande) ? demande : moisEcoule;
  const [liste, transmissions] = await Promise.all([listChargesToReimburse(getDeps(), acteur, mois), listTransmissions(getDeps(), acteur)]);
  const nomDuMois = (m: string) => format.dateTime(new Date(`${m}-01T00:00:00Z`), { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <p className="max-w-3xl print:hidden">{t("introduction")}</p>
      <Notice searchParams={searchParams} />
      <form className="mt-4 mb-2 flex flex-wrap items-end gap-3 print:hidden">
        <label>
          {t("mois")}
          <input type="month" name="mois" defaultValue={mois} max={moisCourant} required />
        </label>
        <button type="submit">{t("afficher")}</button>
      </form>

      <section aria-labelledby="a-transmettre">
        <h2 id="a-transmettre">{t("aTransmettre", { mois: nomDuMois(mois) })}</h2>
        {liste.count === 0 ? (
          <p>{t("aucun")}</p>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-x-6 gap-y-2 print:hidden">
              <a href={`/gestion/remboursements/export?mois=${mois}`} download className="inline-flex items-center gap-1">
                <FileSpreadsheet aria-hidden="true" className="size-4" />
                {t("exporterExcel")}
              </a>
              <BoutonImprimer libelle={t("imprimer")} />
            </p>
            <table className="mt-3">
              <thead>
                <tr>
                  <th>{t("colonnes.collaborateur")}</th>
                  <th>{t("colonnes.offre")}</th>
                  <th>{t("colonnes.equipe")}</th>
                  <th>{t("colonnes.preleveLe")}</th>
                  <th className="text-right">{t("colonnes.montantHt")}</th>
                  <th className="text-right">{t("colonnes.montant")}</th>
                </tr>
              </thead>
              {liste.employees.map((e) => (
                <GroupeCollaborateur
                  key={e.uid}
                  uid={e.uid}
                  nom={e.name}
                  adresse={e.email}
                  resume={t("resume", { nombre: e.charges.length, retards: e.charges.filter((c) => c.late).length })}
                  totalHt={euros(e.totalHtEur)}
                  totalTtc={euros(e.totalEur)}
                  prelevements={e.charges.map((c) => ({
                    id: c.id,
                    offre: c.offer,
                    equipe: c.teamAlias,
                    date: jour(c.chargedOn),
                    retard: c.late ? t("retard") : null,
                    ht: euros(c.amountHtEur),
                    ttc: euros(c.amountEur),
                  }))}
                />
              ))}
              <tfoot>
                <tr>
                  <th colSpan={4} scope="row" className="text-right">
                    {t("totalGeneral", { nombre: liste.count })}
                  </th>
                  <td className="text-right font-semibold">{euros(liste.totalHtEur)}</td>
                  <td className="text-right font-semibold">{euros(liste.totalEur)}</td>
                </tr>
              </tfoot>
            </table>
            <details className="mt-4 print:hidden">
              <summary className="cursor-pointer">{t("transmettre")}</summary>
              <p className="text-sm">{t("avertissementTransmission", { nombre: liste.count, total: euros(liste.totalEur) })}</p>
              <form action={transmettreRemboursementsAction}>
                <input type="hidden" name="mois" value={mois} />
                {liste.employees.flatMap((e) => e.charges.map((c) => <input key={c.id} type="hidden" name="prelevements" value={c.id} />))}
                <button type="submit">{t("confirmer")}</button>
              </form>
            </details>
          </>
        )}
      </section>

      <section aria-labelledby="transmissions" className="mt-10 print:hidden">
        <h2 id="transmissions">{t("transmissions.titre")}</h2>
        {transmissions.length === 0 ? (
          <p>{t("transmissions.aucune")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("transmissions.colonnes.date")}</th>
                <th>{t("transmissions.colonnes.par")}</th>
                <th>{t("transmissions.colonnes.mois")}</th>
                <th className="text-right">{t("transmissions.colonnes.nombre")}</th>
                <th className="text-right">{t("transmissions.colonnes.totalHt")}</th>
                <th className="text-right">{t("transmissions.colonnes.total")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {transmissions.map((tr) => (
                <tr key={tr.id}>
                  <td>{date(tr.transmittedAt)}</td>
                  <td>{tr.transmittedBy}</td>
                  <td>{nomDuMois(tr.month)}</td>
                  <td className="text-right">{tr.chargeCount}</td>
                  <td className="text-right">{euros(tr.totalHtEur)}</td>
                  <td className="text-right">{euros(tr.totalEur)}</td>
                  <td>
                    <a href={`/gestion/remboursements/transmissions/${encodeURIComponent(tr.id)}/csv`} download className="inline-flex items-center gap-1">
                      <Download aria-hidden="true" className="size-4" />
                      {t("transmissions.telecharger")}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
