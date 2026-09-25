import { getTranslations } from "next-intl/server";
import { listAllKeys, listKeysToPickUp } from "@/lib/services/keys";
import { getDeps, requireAdminPage } from "@/lib/session";
import { bloquerCleAction, debloquerCleAction, revoquerCleAdminAction } from "../../../actions";
import { DepenseSurBudget, formats, Notice } from "../../../components";
import { AdminNav } from "../admin-nav";

/**
 * F-43, ticket #19 : les clés approuvées qui attendent leur retrait, les clés actives avec la révocation, le blocage
 * et le déblocage par un admin, puis l'archive des clés révoquées ou expirées.
 */
export default async function GestionClesPage(props: PageProps<"/gestion/cles">) {
  const admin = await requireAdminPage();
  const [{ date }, t, cles, domaine, searchParams] = await Promise.all([
    formats(),
    getTranslations("gestion.cles"),
    getTranslations("cles"),
    getTranslations("domaine"),
    props.searchParams,
  ]);
  const [aRetirer, keys] = await Promise.all([listKeysToPickUp(getDeps(), admin), listAllKeys(getDeps(), admin)]);
  const actives = keys.filter((k) => k.status === "CLE_EMISE");
  const archivees = keys.filter((k) => k.status !== "CLE_EMISE");
  const titulaire = (uid: string, email: string) => (
    <td>
      {uid}
      <br />
      <span className="text-xs text-neutral-600">{email}</span>
    </td>
  );

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <Notice searchParams={searchParams} />

      {aRetirer.length > 0 && (
        <section aria-labelledby="a-retirer">
          <h2 id="a-retirer">{t("aRetirer.titre")}</h2>
          <table>
            <thead>
              <tr>
                <th>{t("colonnes.titulaire")}</th>
                <th>{t("colonnes.equipe")}</th>
                <th>{t("colonnes.niveau")}</th>
                <th>{t("aRetirer.colonnes.modeles")}</th>
                <th>{t("aRetirer.colonnes.approuvee")}</th>
                <th>{t("aRetirer.colonnes.echeance")}</th>
              </tr>
            </thead>
            <tbody>
              {aRetirer.map((d) => (
                <tr key={d.requestId}>
                  {titulaire(d.holderUid, d.holderEmail)}
                  <td>{d.teamAlias}</td>
                  <td>{domaine(`niveaux.${d.dataLevel}`)}</td>
                  <td>{d.models.join(", ")}</td>
                  <td>{d.approvedAt ? date(d.approvedAt) : ""}</td>
                  <td>{d.pickupDeadline ? date(d.pickupDeadline) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section aria-labelledby="actives">
        <h2 id="actives">{t("actives")}</h2>
        {actives.length === 0 ? (
          <p>{keys.length === 0 ? t("aucune") : t("aucuneActive")}</p>
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
              {actives.map((k) => (
                <tr key={k.requestId}>
                  {titulaire(k.holderUid, k.holderEmail)}
                  <td>
                    <code className="text-xs break-all">{k.alias}</code>
                  </td>
                  <td>{k.teamAlias}</td>
                  <td>{domaine(`niveaux.${k.dataLevel}`)}</td>
                  <td>{k.gatewayState ? <DepenseSurBudget spend={k.gatewayState.spend} maxBudget={k.gatewayState.maxBudget} /> : ""}</td>
                  <td>{k.expiresAt ? date(k.expiresAt) : domaine("durees.0")}</td>
                  <td>
                    {domaine(`statuts.${k.status}`)}
                    {k.gatewayState?.blocked && ` · ${cles("bloquee")}`}
                  </td>
                  <td>
                    <form action={k.gatewayState?.blocked ? debloquerCleAction : bloquerCleAction}>
                      <input type="hidden" name="id" value={k.requestId} />
                      <button type="submit" className="mt-0 border-neutral-400 bg-white text-neutral-800 hover:bg-neutral-100">
                        {k.gatewayState?.blocked ? t("debloquer") : t("bloquer")}
                      </button>
                    </form>
                    <details>
                      <summary className="cursor-pointer">{t("revoquer")}</summary>
                      <p className="text-sm">{t("revocationAvertissement")}</p>
                      <form action={revoquerCleAdminAction}>
                        <input type="hidden" name="id" value={k.requestId} />
                        <button type="submit">{t("confirmerRevocation")}</button>
                      </form>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="archive-cles" className="mt-10">
        <h2 id="archive-cles">{t("archive.titre")}</h2>
        {archivees.length === 0 ? (
          <p>{t("archive.aucune")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colonnes.titulaire")}</th>
                <th>{t("colonnes.alias")}</th>
                <th>{t("colonnes.equipe")}</th>
                <th>{t("colonnes.niveau")}</th>
                <th>{t("archive.colonnes.emise")}</th>
                <th>{t("colonnes.expiration")}</th>
                <th>{t("colonnes.statut")}</th>
              </tr>
            </thead>
            <tbody>
              {archivees.map((k) => (
                <tr key={k.requestId}>
                  {titulaire(k.holderUid, k.holderEmail)}
                  <td>
                    <code className="text-xs break-all">{k.alias}</code>
                  </td>
                  <td>{k.teamAlias}</td>
                  <td>{domaine(`niveaux.${k.dataLevel}`)}</td>
                  <td>{date(k.issuedAt)}</td>
                  <td>{k.expiresAt ? date(k.expiresAt) : domaine("durees.0")}</td>
                  <td>{domaine(`statuts.${k.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
