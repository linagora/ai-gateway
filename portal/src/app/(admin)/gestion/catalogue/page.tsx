import { HOSTING_LABELS, LEVEL_LABELS } from "@/lib/labels";
import { DATA_LEVELS } from "@/lib/policy";
import { listCatalogForAdmin } from "@/lib/services/catalog";
import { getDeps, requireAdminPage } from "@/lib/session";
import { saveCatalogEntryAction } from "../../../actions";
import { euros, Notice } from "../../../components";
import { AdminNav } from "../admin-nav";

/** F-50 (sans la synchronisation vers LiteLLM) : enrichissement des modèles déclarés dans LiteLLM. */
export default async function AdminCataloguePage(props: PageProps<"/gestion/catalogue">) {
  const admin = await requireAdminPage();
  const searchParams = await props.searchParams;
  const models = await listCatalogForAdmin(getDeps(), admin);

  return (
    <>
      <AdminNav />
      <h1>Catalogue enrichi</h1>
      <Notice searchParams={searchParams} />
      <p>
        Un modèle n&apos;est visible des utilisateurs qu&apos;une fois enrichi et marqué visible, et seulement s&apos;il a un tarif en
        euros dans LiteLLM.
      </p>
      {models.map((m) => (
        <section key={m.modelName} className="mt-6 border-t pt-4">
          <h2 className="mt-0">
            <code>{m.modelName}</code> · {m.provider ?? "—"} · {m.hasEuroPricing ? `${euros(m.inputPricePerMillion)} / ${euros(m.outputPricePerMillion)} par million de jetons` : "⚠ pas de tarif en euros"}
            {!m.entry && " · non enrichi"}
          </h2>
          <form action={saveCatalogEntryAction}>
            <input type="hidden" name="modelName" value={m.modelName} />
            <label>
              Nom affiché
              <input name="displayName" required defaultValue={m.entry?.displayName ?? m.modelName} />
            </label>
            <label>
              Description
              <textarea name="description" required rows={2} defaultValue={m.entry?.description ?? ""} />
            </label>
            <label>
              Cas d&apos;usage
              <input name="useCases" defaultValue={m.entry?.useCases ?? ""} />
            </label>
            <label>
              Catégorie (texte, code, vision, embeddings…)
              <input name="category" defaultValue={m.entry?.category ?? ""} />
            </label>
            <label>
              Hébergement
              <select name="hosting" defaultValue={m.entry?.hosting ?? "UE"}>
                {(Object.keys(HOSTING_LABELS) as (keyof typeof HOSTING_LABELS)[]).map((h) => (
                  <option key={h} value={h}>
                    {HOSTING_LABELS[h]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Niveau maximal de données
              <select name="dataLevel" defaultValue={m.entry?.dataLevel ?? "N1"}>
                {DATA_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {LEVEL_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="font-normal">
              <input type="checkbox" name="visible" defaultChecked={m.entry?.visible ?? false} /> Visible des utilisateurs
            </label>
            <button type="submit">Enregistrer</button>
          </form>
        </section>
      ))}
      {models.length === 0 && <p>Aucun modèle n&apos;est déclaré dans LiteLLM.</p>}
    </>
  );
}
