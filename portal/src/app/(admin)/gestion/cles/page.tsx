import { getTranslations } from "next-intl/server";
import { listAllKeys } from "@/lib/services/keys";
import { getDeps, requireAdminPage } from "@/lib/session";
import { revoquerCleAdminAction } from "../../../actions";
import { formats, Notice } from "../../../components";
import { AdminNav } from "../admin-nav";

/** F-43, ticket #19 : toutes les clés émises, avec la révocation par un admin. */
export default async function GestionClesPage(props: PageProps<"/gestion/cles">) {
  const admin = await requireAdminPage();
  const [{ date, euros }, t, cles, domaine, searchParams] = await Promise.all([
    formats(),
    getTranslations("gestion.cles"),
    getTranslations("cles"),
    getTranslations("domaine"),
    props.searchParams,
  ]);
  const keys = await listAllKeys(getDeps(), admin);

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <Notice searchParams={searchParams} />
      {keys.length === 0 ? (
        <p>{t("aucune")}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{t("colonnes.titulaire")}</th>
              <th>{t("colonnes.alias")}</th>
              <th>{t("colonnes.equipe")}</th>
              <th>{t("colonnes.niveau")}</th>
              <th>{t("colonnes.depense")}</th>
              <th>{t("colonnes.expiration")}</th>
              <th>{t("colonnes.statut")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.requestId}>
                <td>
                  {k.holderUid}
                  <br />
                  <span className="text-xs text-neutral-600">{k.holderEmail}</span>
                </td>
                <td>
                  <code className="text-xs break-all">{k.alias}</code>
                </td>
                <td>{k.teamAlias}</td>
                <td>{domaine(`niveaux.${k.dataLevel}`)}</td>
                <td>
                  {k.usage
                    ? cles("depenseSur", {
                        depense: k.usage.spend > 0 && k.usage.spend < 0.01 ? cles("moinsDunCentime") : euros(k.usage.spend),
                        budget: euros(k.usage.maxBudget),
                      })
                    : "—"}
                </td>
                <td>{k.expiresAt ? date(k.expiresAt) : "—"}</td>
                <td>
                  {domaine(`statuts.${k.status}`)}
                  {k.usage?.blocked && ` · ${cles("bloquee")}`}
                </td>
                <td>
                  {k.status === "CLE_EMISE" && (
                    <details>
                      <summary className="cursor-pointer">{t("revoquer")}</summary>
                      <p className="text-sm">{t("revocationAvertissement")}</p>
                      <form action={revoquerCleAdminAction}>
                        <input type="hidden" name="id" value={k.requestId} />
                        <button type="submit">{t("confirmerRevocation")}</button>
                      </form>
                    </details>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
