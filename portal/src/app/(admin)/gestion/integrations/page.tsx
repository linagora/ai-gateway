import { getTranslations } from "next-intl/server";
import { ALGORITHMES } from "@/lib/integrations/cles-publiques";
import { BORNES, type IntegrationKeyView, type IntegrationView, listIntegrations, PERIMETRES, PLAFOND_PAR_DEFAUT } from "@/lib/services/integrations";
import { getDeps, requireAdminPage } from "@/lib/session";
import {
  activerIntegrationAction,
  ajouterCleIntegrationAction,
  declarerIntegrationAction,
  desactiverIntegrationAction,
  modifierIntegrationAction,
  mettreCleHorsServiceAction,
} from "../../../actions";
import { ExplicationObligatoires, Notice } from "../../../components";
import { Obligatoire } from "../../../obligatoire";
import { AdminNav } from "../admin-nav";

/**
 * Onglet « Intégrations » (spécification #71, ticket #74), réservé aux admins : les intégrations actives, puis les
 * désactivées, repliées ; `?integration=` déplie celle qu'une action vient de viser. Au bas de la page, la déclaration.
 */
export default async function IntegrationsPage(props: PageProps<"/gestion/integrations">) {
  const admin = await requireAdminPage();
  const [t, searchParams] = await Promise.all([getTranslations("gestion.integrations"), props.searchParams]);
  const integrations = await listIntegrations(getDeps(), admin);
  const visee = typeof searchParams.integration === "string" ? searchParams.integration : null;
  const [actives, desactivees] = [integrations.filter((i) => i.active), integrations.filter((i) => !i.active)];

  return (
    <>
      <AdminNav />
      <h1>{t("titre")}</h1>
      <p className="text-sm text-neutral-600">{t("introduction")}</p>
      <ExplicationObligatoires />
      <Notice searchParams={searchParams} />

      <section aria-labelledby="actives">
        <h2 id="actives">{t("actives")}</h2>
        {actives.length === 0 && <p>{t("aucuneActive")}</p>}
        {actives.map((i) => (
          <FicheIntegration key={i.id} integration={i} ouverte />
        ))}
      </section>

      {desactivees.length > 0 && (
        <section aria-labelledby="desactivees" className="mt-8">
          <h2 id="desactivees">{t("desactivees", { nombre: desactivees.length })}</h2>
          {desactivees.map((i) => (
            <FicheIntegration key={i.id} integration={i} ouverte={i.id === visee} />
          ))}
        </section>
      )}

      <section aria-labelledby="declarer" className="mt-10 border-t pt-4">
        <h2 id="declarer">{t("declarer")}</h2>
        <form action={declarerIntegrationAction} aria-label={t("declarer")}>
          <label>
            {t("identifiant")}
            <Obligatoire />
            <input name="id" required minLength={BORNES.identifiant.minimum} maxLength={BORNES.identifiant.maximum} pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          </label>
          <p className="text-xs text-neutral-600">{t("aideIdentifiant")}</p>
          <ChampsReglages />
          <p className="text-sm">{t("aideDeclarer")}</p>
          <button type="submit">{t("boutonDeclarer")}</button>
        </form>
      </section>
    </>
  );
}

/** Une intégration, repliable : son état et son activation, ses réglages, ses clés publiques. */
async function FicheIntegration({ integration: i, ouverte }: { integration: IntegrationView; ouverte: boolean }) {
  const t = await getTranslations("gestion.integrations");
  return (
    <details open={ouverte} className="mt-4 border-t pt-3">
      <summary className="cursor-pointer">
        <h3 className="my-0 inline font-semibold" id={`integration-${i.id}`}>
          {i.name}
        </h3>{" "}
        <code>{i.id}</code> <span className="text-sm text-neutral-500">({t("etat", { active: String(i.active) })})</span>
      </summary>
      <section aria-labelledby={`integration-${i.id}`}>
        <p className="text-sm text-neutral-600">{t("declaree", { date: i.createdAt, auteur: i.createdBy })}</p>
        <form action={i.active ? desactiverIntegrationAction : activerIntegrationAction}>
          <input type="hidden" name="id" value={i.id} />
          <p className="text-sm">{i.active ? t("aideDesactiver") : t("aideActiver")}</p>
          <button type="submit" className="mt-0">
            {i.active ? t("desactiver") : t("activer")}
          </button>
        </form>

        <h4 className="mt-6 font-semibold">{t("reglages")}</h4>
        <form action={modifierIntegrationAction} aria-label={`${t("reglages")} ${i.name}`}>
          <input type="hidden" name="id" value={i.id} />
          <ChampsReglages integration={i} />
          <button type="submit">{t("enregistrer")}</button>
        </form>

        <h4 className="mt-6 font-semibold">{t("cles")}</h4>
        {i.keys.length === 0 ? <p>{t("aucuneCle")}</p> : <TableCles integration={i} cles={i.keys} />}
        {i.removedKeys.length > 0 && (
          <details>
            <summary className="cursor-pointer">{t("clesHorsService", { nombre: i.removedKeys.length })}</summary>
            <TableCles integration={i} cles={i.removedKeys} />
          </details>
        )}
        <form action={ajouterCleIntegrationAction} aria-label={`${t("ajouterCle")} ${i.name}`}>
          <input type="hidden" name="id" value={i.id} />
          <div className="grid gap-x-6 md:grid-cols-2">
            <label>
              {t("kid")}
              <Obligatoire />
              <input name="kid" required maxLength={BORNES.kid} pattern="[A-Za-z0-9._\-]+" />
            </label>
            <label>
              {t("algorithme")}
              <select name="algorithm" defaultValue="EdDSA">
                {ALGORITHMES.map((a) => (
                  <option key={a} value={a}>
                    {t(`algorithmes.${a}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            {t("clePublique")}
            <Obligatoire />
            <textarea name="publicKeyPem" required rows={4} className="font-mono text-xs" />
          </label>
          <p className="text-xs text-neutral-600">{t("aideClePublique")}</p>
          <button type="submit">{t("ajouter")}</button>
        </form>
      </section>
    </details>
  );
}

/** Nom, périmètre, adresses et plafond : champs de la déclaration et de la modification d'une intégration. */
async function ChampsReglages({ integration }: { integration?: IntegrationView }) {
  const t = await getTranslations("gestion.integrations");
  return (
    <>
      <label>
        {t("nom")}
        <Obligatoire />
        <input name="name" required maxLength={BORNES.nom} defaultValue={integration?.name} />
      </label>
      <fieldset>
        <legend className="font-medium">{t("perimetre")}</legend>
        {PERIMETRES.map((p) => (
          <label key={p} className="font-normal">
            <input type="checkbox" name="scopes" value={p} defaultChecked={integration?.scopes.includes(p) ?? false} /> {t(`perimetres.${p}`)}
          </label>
        ))}
      </fieldset>
      <label>
        {t("adresses")}
        <textarea name="ipRanges" rows={3} className="font-mono text-sm" defaultValue={integration?.ipRanges.join("\n")} />
      </label>
      <p className="text-xs text-neutral-600">{t("aideAdresses")}</p>
      <label>
        {t("plafond")}
        <Obligatoire />
        <input
          name="rateLimitPerMinute"
          type="number"
          required
          min={1}
          max={BORNES.plafond}
          step={1}
          defaultValue={integration?.rateLimitPerMinute ?? PLAFOND_PAR_DEFAUT}
        />
      </label>
      <p className="text-xs text-neutral-600">{t("aidePlafond")}</p>
    </>
  );
}

/** Clés publiques d'une intégration, en service ou hors service : identifiant, algorithme, empreinte, ajout, mise hors service. */
async function TableCles({ integration, cles }: { integration: IntegrationView; cles: IntegrationKeyView[] }) {
  const t = await getTranslations("gestion.integrations");
  const horsService = cles.some((c) => c.removedAt);
  return (
    <div className="overflow-x-auto">
      <table>
        <thead>
          <tr>
            <th>{t("kid")}</th>
            <th>{t("algorithme")}</th>
            <th>{t("empreinte")}</th>
            <th>{t("ajoutee")}</th>
            <th>{horsService ? t("horsService") : <span className="sr-only">{t("mettreHorsService")}</span>}</th>
          </tr>
        </thead>
        <tbody>
          {cles.map((c) => (
            <tr key={c.kid}>
              <td>
                <code>{c.kid}</code>
              </td>
              <td>{c.algorithm}</td>
              <td>
                <code className="break-all text-xs">{c.fingerprint}</code>
              </td>
              <td>{t("parLe", { date: c.createdAt, auteur: c.createdBy })}</td>
              <td>
                {c.removedAt ? (
                  t("parLe", { date: c.removedAt, auteur: c.removedBy ?? "" })
                ) : (
                  <details>
                    <summary className="cursor-pointer">{t("mettreHorsService")}</summary>
                    <p className="text-sm">{t("avertissementHorsService")}</p>
                    <form action={mettreCleHorsServiceAction}>
                      <input type="hidden" name="id" value={integration.id} />
                      <input type="hidden" name="kid" value={c.kid} />
                      <button type="submit">{t("confirmerHorsService", { kid: c.kid })}</button>
                    </form>
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
