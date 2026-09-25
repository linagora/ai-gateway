import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LEVEL_DESCRIPTIONS, LEVEL_LABELS } from "@/lib/labels";
import { DATA_LEVELS } from "@/lib/policy";
import { listCatalog } from "@/lib/services/catalog";
import { getDeps, requireUser } from "@/lib/session";
import { Notice, formats } from "../../components";

/** F-10 à F-12 : catalogue des modèles visibles, filtrable par niveau et éditeur (remplacé par les tickets #5 et #7). */
export default async function CataloguePage(props: PageProps<"/catalogue">) {
  await requireUser();
  const [{ euros, nombre }, t] = await Promise.all([formats(), getTranslations("domaine")]);
  const searchParams = await props.searchParams;
  const pick = (name: string) => (typeof searchParams[name] === "string" ? (searchParams[name] as string) : "");
  const [level, publisher] = [pick("niveau"), pick("editeur")];

  const catalog = await listCatalog(getDeps());
  const items = catalog.filter(
    (m) => (!level || m.dataLevel === level) && (!publisher || m.publisher === publisher),
  );
  const publishers = [...new Set(catalog.map((m) => m.publisher).filter(Boolean))] as string[];

  return (
    <>
      <h1>Catalogue des modèles</h1>
      <Notice searchParams={searchParams} />
      <form className="flex flex-wrap items-end gap-4" method="get">
        <label>
          Niveau de données
          <select name="niveau" defaultValue={level}>
            <option value="">Tous</option>
            {DATA_LEVELS.map((l) => (
              <option key={l} value={l}>
                {LEVEL_LABELS[l]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Éditeur
          <select name="editeur" defaultValue={publisher}>
            <option value="">Tous</option>
            {publishers.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <button type="submit">Filtrer</button>
      </form>

      <table className="mt-6">
        <thead>
          <tr>
            <th>Modèle</th>
            <th>Niveau max.</th>
            <th>Prix entrée / sortie (par million de jetons)</th>
            <th>Contexte max.</th>
            <th>Description</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.modelName}>
              <td>
                <strong>{m.displayName}</strong>
                <br />
                {m.publisher ?? "—"} · {m.executionRegion ? t(`zones.${m.executionRegion}`) : "—"}
                <br />
                <code>{m.modelName}</code>
              </td>
              <td title={LEVEL_DESCRIPTIONS[m.dataLevel]}>{LEVEL_LABELS[m.dataLevel]}</td>
              <td>
                {euros(m.inputPricePerMillion)} / {euros(m.outputPricePerMillion)}
              </td>
              <td>{nombre(m.maxInputTokens)}</td>
              <td>
                {m.description}
                {m.useCases.length > 0 && <p className="text-sm text-neutral-600">{m.useCases.map((u) => t(`casUsage.${u}`)).join(" · ")}</p>}
              </td>
              <td>
                <Link href={`/demandes/nouvelle?modele=${encodeURIComponent(m.modelName)}`}>Demander l&apos;accès</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {items.length === 0 && <p className="mt-4">Aucun modèle ne correspond à ces critères.</p>}
    </>
  );
}
