import { getTranslations } from "next-intl/server";
import { listAllKeys } from "@/lib/services/keys";
import { getDeps, requireAdminPage } from "@/lib/session";
import { bloquerCleAction, debloquerCleAction, revoquerCleAdminAction } from "../../../actions";
import { DepenseSurBudget, formats, Notice } from "../../../components";
import { AdminNav } from "../admin-nav";

/** F-43, ticket #19 : toutes les clés émises, avec la révocation par un admin. */
export default async function GestionClesPage(props: PageProps<"/gestion/cles">) {
  const admin = await requireAdminPage();
  const [{ date }, t, cles, domaine, searchParams] = await Promise.all([
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
                  {k.gatewayState ? <DepenseSurBudget spend={k.gatewayState.spend} maxBudget={k.gatewayState.maxBudget} /> : "—"}
                </td>
                <td>{k.expiresAt ? date(k.expiresAt) : "—"}</td>
                <td>
                  {domaine(`statuts.${k.status}`)}
                  {k.gatewayState?.blocked && ` · ${cles("bloquee")}`}
                </td>
                <td>
                  {k.status === "CLE_EMISE" && (
                    <form action={k.gatewayState?.blocked ? debloquerCleAction : bloquerCleAction}>
                      <input type="hidden" name="id" value={k.requestId} />
                      <button type="submit" className="mt-0 border-neutral-400 bg-white text-neutral-800 hover:bg-neutral-100">
                        {k.gatewayState?.blocked ? t("debloquer") : t("bloquer")}
                      </button>
                    </form>
                  )}
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
