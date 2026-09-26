import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PortalError } from "@/lib/errors";
import { getTeamPage } from "@/lib/services/teams";
import { getDeps, requireAdminPage } from "@/lib/session";
import {
  ajouterMembreAction,
  designerResponsableAction,
  faireSortirMembreAction,
  renommerEquipeAction,
  retirerResponsableAction,
  supprimerEquipeAction,
} from "../../../../actions";
import { Notice } from "../../../../components";
import { AdminNav } from "../../admin-nav";

/** F-53 et F-54 : page d'une équipe : son résumé, son renommage, ses responsables et ses membres (ajout direct, sortie d'une équipe). */
export default async function EquipePage(props: PageProps<"/gestion/equipes/[id]">) {
  const admin = await requireAdminPage();
  const [{ id }, t, searchParams] = await Promise.all([props.params, getTranslations("gestion.equipes"), props.searchParams]);
  const equipe = await getTeamPage(getDeps(), admin, decodeURIComponent(id)).catch((e: unknown) => {
    if (e instanceof PortalError && e.code === "introuvable") notFound();
    throw e;
  });

  return (
    <>
      <AdminNav />
      <p>
        <Link href="/gestion/equipes">
          <span aria-hidden="true">← </span>
          {t("toutes")}
        </Link>
      </p>
      <h1>{equipe.teamAlias}</h1>
      <Notice searchParams={searchParams} />
      <dl className="grid grid-cols-[12rem_1fr] gap-x-4 gap-y-1" aria-label={t("resume")}>
        <dt>{t("colonnes.membres")}</dt>
        <dd>{equipe.memberCount}</dd>
        <dt>{t("colonnes.cles")}</dt>
        <dd>{equipe.activeKeyCount}</dd>
      </dl>
      <form action={renommerEquipeAction} className="mt-6 flex flex-wrap items-end gap-3">
        <input type="hidden" name="id" value={equipe.teamId} />
        <label>
          {t("nom")}
          <input name="nom" required maxLength={100} defaultValue={equipe.teamAlias} />
        </label>
        <button type="submit">{t("renommer")}</button>
      </form>

      <section aria-labelledby="responsables" className="mt-8">
        <h2 id="responsables">{t("responsables")}</h2>
        {equipe.managers.length === 0 ? (
          <p>{t("aucunResponsable")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colonneResponsable")}</th>
                <th>{t("colonneAdresse")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {equipe.managers.map((m) => (
                <tr key={m.uid}>
                  <td>{m.uid}</td>
                  <td>{m.email}</td>
                  <td>
                    <form action={retirerResponsableAction}>
                      <input type="hidden" name="id" value={equipe.teamId} />
                      <input type="hidden" name="uid" value={m.uid} />
                      <button type="submit" className="border-neutral-400 bg-white text-neutral-800 hover:bg-neutral-100">
                        {t("retirerRole")}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form action={designerResponsableAction} className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={equipe.teamId} />
          <label>
            {t("uidResponsable")}
            <input name="uid" required />
          </label>
          <button type="submit">{t("designer")}</button>
        </form>
      </section>

      <section aria-labelledby="membres" className="mt-8">
        <h2 id="membres">{t("membres")}</h2>
        {equipe.members.length === 0 ? (
          <p>{t("aucunMembre")}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{t("colonneMembre")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {equipe.members.map((uid) => (
                <tr key={uid}>
                  <td>{uid}</td>
                  <td>
                    <details>
                      <summary className="cursor-pointer">{t("faireSortir")}</summary>
                      <p className="text-sm">{t("avertissementSortie")}</p>
                      <form action={faireSortirMembreAction}>
                        <input type="hidden" name="id" value={equipe.teamId} />
                        <input type="hidden" name="uid" value={uid} />
                        <button type="submit">{t("confirmerSortie")}</button>
                      </form>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form action={ajouterMembreAction} className="mt-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="id" value={equipe.teamId} />
          <label>
            {t("uid")}
            <input name="uid" required />
          </label>
          <button type="submit">{t("ajouter")}</button>
        </form>
      </section>

      <section aria-labelledby="suppression" className="mt-10">
        <h2 id="suppression">{t("suppression.titre")}</h2>
        <details>
          <summary className="cursor-pointer">{t("suppression.supprimer")}</summary>
          <p className="text-sm">{t("suppression.avertissement")}</p>
          <form action={supprimerEquipeAction}>
            <input type="hidden" name="id" value={equipe.teamId} />
            <button type="submit">{t("suppression.confirmer")}</button>
          </form>
        </details>
      </section>
    </>
  );
}
