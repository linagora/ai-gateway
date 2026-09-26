import { getTranslations } from "next-intl/server";
import type { SessionUser } from "@/lib/auth-user";
import type { AdminKey } from "@/lib/services/keys";
import type { AdminSubscription } from "@/lib/services/subscriptions";
import { bloquerCleAction, debloquerCleAction, declarerResiliationGestionAction, demanderResiliationAction, revoquerCleAdminAction } from "../../actions";
import { Obligatoire } from "../../obligatoire";

/** Page où revenir après une action : l'onglet filtré sur une équipe, ou la fiche d'un salarié. */
export interface Retour {
  equipe?: string;
  salarie?: string;
}

function ChampsRetour({ retour }: { retour: Retour }) {
  return (
    <>
      {retour.equipe && <input type="hidden" name="equipe" value={retour.equipe} />}
      {retour.salarie && <input type="hidden" name="salarie" value={retour.salarie} />}
    </>
  );
}

/**
 * F-43 : blocage ou déblocage, et révocation d'une clé active, par un admin ou un responsable de son équipe ; un
 * responsable ne bloque ni ne débloque sa propre clé (quatre yeux).
 */
export async function ActionsCle({ cle, acteur, retour = {} }: { cle: AdminKey; acteur: SessionUser; retour?: Retour }) {
  const t = await getTranslations("gestion.cles");
  return (
    <>
      {(acteur.isAdmin || cle.holderUid !== acteur.uid) && (
        <form action={cle.gatewayState?.blocked ? debloquerCleAction : bloquerCleAction}>
          <input type="hidden" name="id" value={cle.requestId} />
          <ChampsRetour retour={retour} />
          <button type="submit" className="mt-0 border-neutral-400 bg-white text-neutral-800 hover:bg-neutral-100">
            {cle.gatewayState?.blocked ? t("debloquer") : t("bloquer")}
          </button>
        </form>
      )}
      <details>
        <summary className="cursor-pointer">{t("revoquer")}</summary>
        <p className="text-sm">{t("revocationAvertissement")}</p>
        <form action={revoquerCleAdminAction}>
          <input type="hidden" name="id" value={cle.requestId} />
          <ChampsRetour retour={retour} />
          <button type="submit">{t("confirmerRevocation")}</button>
        </form>
      </details>
    </>
  );
}

/**
 * Ticket #58 : demander la résiliation d'un abonnement actif ; pour un admin, déclarer la résiliation à la place du
 * titulaire.
 */
export async function ActionsAbonnement({ abonnement: a, acteur, retour = {} }: { abonnement: AdminSubscription; acteur: SessionUser; retour?: Retour }) {
  const t = await getTranslations("gestion.abonnements");
  // Jour d'aujourd'hui (AAAA-MM-JJ) : date de résiliation proposée, et date maximale.
  const aujourdhui = new Date().toISOString().slice(0, 10);
  return (
    <>
      {a.status === "ACTIF" && (
        <details>
          <summary>{t("resiliation.demander")}</summary>
          <form action={demanderResiliationAction} aria-label={t("resiliation.formulaireDemande", { offre: a.offer, titulaire: a.holderUid })}>
            <input type="hidden" name="subscriptionId" value={a.id} />
            <ChampsRetour retour={retour} />
            <label>
              {t("resiliation.motif")}
              <Obligatoire />
              <textarea name="reason" required rows={2} />
            </label>
            <p className="text-xs text-neutral-600">{t("resiliation.aideDemande")}</p>
            <button type="submit">{t("resiliation.envoyer")}</button>
          </form>
        </details>
      )}
      {acteur.isAdmin && (
        <details>
          <summary>{t("resiliation.declarer")}</summary>
          <form action={declarerResiliationGestionAction} aria-label={t("resiliation.formulaireDeclaration", { offre: a.offer, titulaire: a.holderUid })}>
            <input type="hidden" name="subscriptionId" value={a.id} />
            <ChampsRetour retour={retour} />
            <label>
              {t("resiliation.date")}
              <input type="date" name="terminatedOn" required min={a.subscribedAt.toISOString().slice(0, 10)} max={aujourdhui} defaultValue={aujourdhui} />
            </label>
            <p className="text-xs text-neutral-600">{t("resiliation.aideDeclaration")}</p>
            <button type="submit">{t("resiliation.enregistrer")}</button>
          </form>
        </details>
      )}
    </>
  );
}
