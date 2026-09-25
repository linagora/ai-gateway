import { z } from "zod";
import type { SessionUser } from "@/lib/auth-user";
import type { Db } from "@/lib/db";
import { requireAdmin } from "@/lib/rbac";

const positiveNumber = z.string().regex(/^\d+(\.\d+)?$/, "nombre positif attendu");
const positiveInteger = z.string().regex(/^[1-9]\d*$/, "entier positif attendu");

/** F-51 : valeurs par défaut configurables (brief §2, modèle Setting). Aucune valeur codée en dur. */
export const settingsSchema = z
  .object({
    default_budget: positiveNumber,
    default_budget_duration: z.string().regex(/^\d+[smhd]$/, "durée LiteLLM attendue, ex. 30d"),
    default_days: positiveInteger,
    default_rpm: positiveInteger,
    default_tpm: positiveInteger,
    pickup_days: positiveInteger,
  })
  .partial()
  .strict();

export type SettingValues = z.infer<typeof settingsSchema>;

export async function saveSettings(deps: { db: Db }, actor: SessionUser, values: SettingValues): Promise<void> {
  requireAdmin(actor);
  const parsed = settingsSchema.parse(values);
  await deps.db.$transaction(
    Object.entries(parsed).map(([key, value]) =>
      deps.db.setting.upsert({ where: { key }, create: { key, value, updatedBy: actor.uid }, update: { value, updatedBy: actor.uid } }),
    ),
  );
}

export async function readSettings(db: Db): Promise<SettingValues> {
  const rows = await db.setting.findMany();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
