import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { DUREES_VALIDITE, optionsDuree } from "@/lib/durees";
import type { SessionUser } from "@/lib/auth-user";
import { countAdminPending } from "@/lib/services/admin-requests";
import { equipesGerees } from "@/lib/services/autorite";
import { approversByTeam } from "@/lib/services/teams";
import { getCurrentUser, getDeps } from "@/lib/session";
import { changerLangueAction, signOutAction } from "./actions";
import type { EquipeProposee } from "./choix-equipe";
import { Pastille } from "./pastille";

/** Sélecteur FR | EN : chaque langue est nommée dans sa propre langue. */
export async function SelecteurLangue() {
  const [langue, t] = await Promise.all([getLocale(), getTranslations("entete")]);
  return (
    <form action={changerLangueAction} className="flex gap-1" role="group" aria-label={t("langue")}>
      {[
        { code: "fr", nom: "Français" },
        { code: "en", nom: "English" },
      ].map(({ code, nom }) => (
        <button
          key={code}
          type="submit"
          name="langue"
          value={code}
          aria-label={nom}
          aria-pressed={langue === code}
          className={`mt-0 px-2 py-0.5 text-sm ${langue === code ? "" : "border-neutral-400 bg-white text-neutral-700"}`}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </form>
  );
}

/** Nom de l'utilisateur, accès à la gestion (admins) et déconnexion. */
export async function UserMenu() {
  const [user, t] = await Promise.all([getCurrentUser(), getTranslations("entete")]);
  if (!user) return null;
  // Admins et responsables d'équipe ont une gestion ; celle d'un responsable se limite à ses équipes.
  const equipes = await equipesGerees(getDeps().db, user);
  const gestion = equipes === null || equipes.length > 0;
  const aValider = gestion ? (await countAdminPending(getDeps(), user)).demandes : 0;
  return (
    <div className="ml-auto flex items-center gap-4">
      {gestion && (
        <Link href="/gestion/demandes">
          {t("gestion")}
          <Pastille nombre={aValider} libelle={t("aValider", { nombre: aValider })} />
        </Link>
      )}
      <span>{user.name}</span>
      <form action={signOutAction}>
        <button type="submit" className="mt-0 border-neutral-400 bg-white text-neutral-800 hover:bg-neutral-100">
          {t("deconnexion")}
        </button>
      </form>
    </div>
  );
}

/**
 * Message de succès ou d'erreur transmis par une Server Action : clé de succès (?ok=), ou code
 * d'erreur (?erreur=) avec ses paramètres (?details= en JSON, ?controles= pour la politique).
 */
export async function Notice({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const t = await getTranslations("avis");
  const lire = (nom: string) => (typeof searchParams[nom] === "string" ? (searchParams[nom] as string) : null);
  const [ok, erreur] = [lire("ok"), lire("erreur")];
  if (erreur) {
    const texte = t.has(`erreurs.${erreur}`) ? t(`erreurs.${erreur}`, parametresErreur(lire, t)) : t("erreurs.inconnue");
    return <p className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-red-800" role="alert">{texte}</p>;
  }
  if (ok && t.has(`succes.${ok}`)) {
    return <p className="mb-4 rounded border border-green-300 bg-green-50 p-3 text-green-800" role="status">{t(`succes.${ok}`)}</p>;
  }
  return null;
}

/** Paramètres d'un message d'erreur ; les contrôles de politique en échec sont traduits un à un. */
function parametresErreur(lire: (nom: string) => string | null, t: Awaited<ReturnType<typeof getTranslations<"avis">>>) {
  let details: Record<string, string> = {};
  try {
    const brut: unknown = JSON.parse(lire("details") ?? "{}");
    if (brut && typeof brut === "object") details = Object.fromEntries(Object.entries(brut).map(([cle, valeur]) => [cle, String(valeur)]));
  } catch {
    // paramètres illisibles : message sans détail
  }
  const controles = (lire("controles") ?? "")
    .split(";")
    .filter(Boolean)
    .map((controle) => {
      const [id, enCause = ""] = controle.split(":");
      const libelle = t.has(`controles.${id}`) ? t(`controles.${id}`) : id;
      return enCause ? `${libelle} (${enCause.split(",").join(", ")})` : libelle;
    })
    .join(" ; ");
  // Champs d'une saisie invalide : leur libellé dans la langue de l'utilisateur, jamais leur nom technique.
  const champs = [...new Set((details.champs ?? "").split(", ").filter(Boolean).map((chemin) => chemin.split(".")[0]))]
    .map((champ) => (t.has(`champs.${champ}`) ? t(`champs.${champ}`) : champ))
    .join(", ");
  // Paramètres attendus par les messages (ICU) : une valeur vide choisit la variante par défaut.
  return { objet: "", cas: "", modele: "", equipe: "", ...details, champs, controles };
}

/** Explication des étoiles, en tête d'un formulaire qui a des champs obligatoires. */
export async function ExplicationObligatoires() {
  const t = await getTranslations("formulaire");
  return <p className="mt-4 text-sm text-neutral-600">{t.rich("obligatoires", { etoile: (etoile) => <span className="obligatoire">{etoile}</span> })}</p>;
}

/** Nom d'une durée de validité : « 3 mois », « N'expire jamais », ou « 60 jours » pour une durée hors liste. */
export function libelleDuree(domaine: Awaited<ReturnType<typeof getTranslations<"domaine">>>, jours: number): string {
  return (DUREES_VALIDITE as readonly number[]).includes(jours) ? domaine(`durees.${jours}`) : domaine("dureeEnJours", { nombre: jours });
}

/** Liste des durées de validité ; sans valeur courante, rien n'est présélectionné. */
export async function ChoixDuree({ name, valeur }: { name: string; valeur: number | null }) {
  const domaine = await getTranslations("domaine");
  return (
    <select name={name} defaultValue={valeur ?? ""}>
      {valeur === null && <option value="">{domaine("choisirDuree")}</option>}
      {optionsDuree(valeur).map((jours) => (
        <option key={jours} value={jours}>
          {libelleDuree(domaine, jours)}
        </option>
      ))}
    </select>
  );
}

/**
 * Dépense d'une clé sur son budget, ou « sans plafond » si la clé n'en a pas ; une dépense non nulle de moins d'un
 * centime s'affiche comme telle.
 */
export async function DepenseSurBudget({ spend, maxBudget }: { spend: number; maxBudget: number | null }) {
  const [{ euros }, t] = await Promise.all([formats(), getTranslations("cles")]);
  const depense = spend > 0 && spend < 0.01 ? t("moinsDunCentime") : euros(spend);
  return <>{maxBudget === null ? t("depenseSansPlafond", { depense }) : t("depenseSur", { depense, budget: euros(maxBudget) })}</>;
}

/** Montants, nombres et dates au format de la langue de la requête (1 234,56 € en français, €1,234.56 en anglais). */
export async function formats() {
  const format = await getFormatter();
  return {
    euros: (valeur: number) => format.number(valeur, { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 }),
    nombre: (valeur: number) => format.number(valeur),
    date: (valeur: Date) => format.dateTime(valeur, { dateStyle: "short", timeStyle: "short" }),
  };
}

/**
 * Équipes proposées dans un formulaire de demande, chacune avec qui validera la demande (F-22) : ses responsables, hors
 * le demandeur lui-même, sinon les administrateurs.
 */
export async function equipesProposees(user: SessionUser, teams: { teamId: string; teamAlias: string }[]): Promise<EquipeProposee[]> {
  const [t, valideurs] = await Promise.all([getTranslations("validation"), approversByTeam(getDeps().db, teams.map((team) => team.teamId))]);
  return teams.map(({ teamId, teamAlias }) => {
    const autres = (valideurs.get(teamId) ?? []).filter((uid) => uid !== user.uid);
    return { teamId, teamAlias, valideurs: autres.length > 0 ? t("valideePar", { valideurs: autres.join(", ") }) : t("valideeParAdmins") };
  });
}
