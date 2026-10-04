import { getTranslations } from "next-intl/server";
import { CATEGORIES_NOUVEAUTE, type NouveauteEditable } from "@/lib/services/nouveautes";
import { creerNouveauteAction, modifierNouveauteAction } from "../../../actions";
import { Obligatoire } from "../../../obligatoire";

/** Rédaction d'une nouveauté : un brouillon à créer, ou une nouveauté à corriger, ses textes repris. */
export async function FormulaireNouveaute({ nouveaute }: { nouveaute?: NouveauteEditable }) {
  const [t, domaine] = await Promise.all([getTranslations("gestionNouveautes"), getTranslations("domaine")]);
  return (
    <form action={nouveaute ? modifierNouveauteAction : creerNouveauteAction} aria-label={nouveaute ? t("corrigerTitre") : t("rediger")} className="max-w-3xl">
      {nouveaute && <input type="hidden" name="id" value={nouveaute.id} />}
      <label>
        {t("categorie")}
        <select name="category" defaultValue={nouveaute?.category ?? "MODELES"}>
          {CATEGORIES_NOUVEAUTE.map((c) => (
            <option key={c} value={c}>
              {domaine(`categoriesNouveaute.${c}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("titreFr")}
        <Obligatoire />
        <input name="titleFr" required maxLength={120} defaultValue={nouveaute?.titleFr} />
      </label>
      <label>
        {t("resumeFr")}
        <Obligatoire />
        <textarea name="summaryFr" required maxLength={300} rows={2} aria-describedby="aide-resume" defaultValue={nouveaute?.summaryFr} />
      </label>
      <p id="aide-resume" className="text-xs text-neutral-600">
        {t("aideResume")}
      </p>
      <label>
        {t("texteFr")}
        <Obligatoire />
        <textarea name="bodyFr" required maxLength={20000} rows={8} aria-describedby="aide-texte" defaultValue={nouveaute?.bodyFr} />
      </label>
      <p id="aide-texte" className="text-xs text-neutral-600">
        {t("aideTexte")}
      </p>
      <fieldset>
        <legend>{t("anglais")}</legend>
        <label>
          {t("titreEn")}
          <input name="titleEn" maxLength={120} defaultValue={nouveaute?.titleEn ?? undefined} />
        </label>
        <label>
          {t("resumeEn")}
          <textarea name="summaryEn" maxLength={300} rows={2} defaultValue={nouveaute?.summaryEn ?? undefined} />
        </label>
        <label>
          {t("texteEn")}
          <textarea name="bodyEn" maxLength={20000} rows={8} defaultValue={nouveaute?.bodyEn ?? undefined} />
        </label>
      </fieldset>
      <button type="submit">{nouveaute ? t("enregistrerCorrection") : t("enregistrer")}</button>
    </form>
  );
}
