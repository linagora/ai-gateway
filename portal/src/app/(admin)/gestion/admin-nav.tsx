import { getTranslations } from "next-intl/server";
import { countAdminPending } from "@/lib/services/admin-requests";
import { getDeps, requireGestionPage } from "@/lib/session";
import { Onglets } from "../../onglets";
import { Pastille } from "../../pastille";

/**
 * Menu de la gestion ; sa pastille compte les demandes à valider, seule action qui attend l'admin ou le responsable.
 * Un responsable d'équipe n'y voit que les demandes, les clés, les abonnements, les équipes et leurs collaborateurs (F-54).
 */
export async function AdminNav() {
  const admin = await requireGestionPage();
  const [t, demandes] = await Promise.all([getTranslations("gestion.nav"), countAdminPending(getDeps(), admin)]);
  return (
    <nav className="mb-4 flex gap-4 text-sm print:hidden" aria-label={t("libelle")}>
      <Onglets
        onglets={[
          {
            href: "/gestion/demandes",
            contenu: (
              <>
                {t("demandes")}
                <Pastille nombre={demandes} libelle={t("aValider", { nombre: demandes })} />
              </>
            ),
          },
          { href: "/gestion/cles", contenu: t("cles") },
          { href: "/gestion/abonnements", contenu: t("abonnements") },
          { href: "/gestion/equipes", contenu: t("equipes") },
          { href: "/gestion/collaborateurs", contenu: t("collaborateurs") },
          ...(admin.isAdmin
            ? [
                { href: "/gestion/remboursements", contenu: t("remboursements") },
                { href: "/gestion/catalogue", contenu: t("catalogue") },
                { href: "/gestion/parametres", contenu: t("parametres") },
                { href: "/gestion/integrations", contenu: t("integrations") },
                { href: "/gestion/outils", contenu: t("outils") },
              ]
            : []),
        ]}
      />
    </nav>
  );
}
