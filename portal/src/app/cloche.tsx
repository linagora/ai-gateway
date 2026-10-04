import { Bell } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import type { SessionUser } from "@/lib/auth-user";
import { nouveautesNonLues } from "@/lib/services/nouveautes";
import { getDeps } from "@/lib/session";
import { CategorieNouveaute } from "./categorie-nouveaute";
import { Pastille } from "./pastille";

/**
 * Spécification #124, ticket #130 : cloche des nouveautés, avec la pastille du nombre de non lues. Le panneau est un
 * popover natif du navigateur, rendu côté serveur : il s'ouvre et se ferme au clic sur la cloche, et se ferme par Échap
 * ou par un clic ailleurs, sans JavaScript du portail.
 */
export async function Cloche({ user }: { user: SessionUser }) {
  const [t, format, nonLues] = await Promise.all([getTranslations("nouveautes"), getFormatter(), nouveautesNonLues(getDeps(), user)]);
  return (
    <>
      <button type="button" popoverTarget="nouveautes-panneau" className="mt-0 inline-flex items-center border-0 bg-transparent p-1 text-neutral-700">
        <Bell aria-hidden="true" className="size-5" />
        <span className="sr-only">{t("cloche")}</span>
        <Pastille nombre={nonLues.length} libelle={t("nonLues", { nombre: nonLues.length })} />
      </button>
      <div
        id="nouveautes-panneau"
        popover="auto"
        role="dialog"
        aria-labelledby="nouveautes-panneau-titre"
        className="inset-auto top-14 right-4 m-0 max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-neutral-200 bg-white p-4 shadow-xl"
      >
        <h2 id="nouveautes-panneau-titre" className="mt-0 text-base">
          {t("panneau")}
        </h2>
        {nonLues.length === 0 ? (
          <p className="text-sm">{t("aucune")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {nonLues.map((n) => (
              <li key={n.id} className="border-t border-neutral-100 pt-2 first:border-0 first:pt-0">
                <p className="m-0 flex flex-wrap gap-x-2 text-xs text-neutral-600">
                  <CategorieNouveaute category={n.category} />
                  <span>{format.dateTime(n.publishedAt, { dateStyle: "long" })}</span>
                </p>
                <Link href={`/nouveautes/${n.id}`} className="font-medium">
                  {n.title}
                </Link>
                <p className="m-0 text-sm">{n.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
