import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { getCurrentUser } from "@/lib/session";
import { changerLangueAction, signOutAction } from "./actions";

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
  return (
    <div className="ml-auto flex items-center gap-4">
      {user.isAdmin && <Link href="/gestion/demandes">{t("gestion")}</Link>}
      <span>{user.name}</span>
      <form action={signOutAction}>
        <button type="submit" className="mt-0">
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
  // Paramètres attendus par les messages (ICU) : une valeur vide choisit la variante par défaut.
  return { objet: "", cas: "", modele: "", equipe: "", champs: "", ...details, controles };
}

/** Montants, nombres et dates au format de la langue de la requête (1 234,56 € en français, €1,234.56 en anglais). */
export async function formats() {
  const format = await getFormatter();
  return {
    euros: (valeur: number | null) =>
      valeur === null ? "—" : format.number(valeur, { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 }),
    nombre: (valeur: number | null) => (valeur === null ? "—" : format.number(valeur)),
    date: (valeur: Date) => format.dateTime(valeur, { dateStyle: "short", timeStyle: "short" }),
  };
}
