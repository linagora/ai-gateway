import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listMyKeys } from "@/lib/services/keys";
import { getDeps, requireUser } from "@/lib/session";
import { formats, Notice } from "../../components";
import { RetraitCle } from "./retrait-cle";

/** Tickets #15 et suivants : les demandes approuvées à retirer, puis les clés émises du titulaire. */
export default async function MesClesPage(props: PageProps<"/cles">) {
  const user = await requireUser();
  const [{ date }, t, domaine, searchParams] = await Promise.all([formats(), getTranslations("cles"), getTranslations("domaine"), props.searchParams]);
  const { toPickUp, keys } = await listMyKeys(getDeps(), user);

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
          <table>
            <thead>
              <tr>
                <th>{t("colonnes.alias")}</th>
                <th>{t("colonnes.equipe")}</th>
                <th>{t("colonnes.niveau")}</th>
                <th>{t("colonnes.modeles")}</th>
                <th>{t("colonnes.emise")}</th>
                <th>{t("colonnes.expiration")}</th>
                <th>{t("colonnes.statut")}</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.requestId}>
                  <td>
                    <code>{k.alias}</code>
                  </td>
                  <td>{k.teamAlias}</td>
                  <td>{domaine(`niveaux.${k.dataLevel}`)}</td>
                  <td>{k.models.join(", ")}</td>
                  <td>{date(k.issuedAt)}</td>
                  <td>{k.expiresAt ? date(k.expiresAt) : "—"}</td>
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
