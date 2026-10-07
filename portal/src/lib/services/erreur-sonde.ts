import { type CodeErreurSonde, PROBE_TIMEOUT_MS } from "@/lib/litellm/client";

/**
 * Texte de l'erreur d'une sonde, dans la langue du traducteur : le message de LiteLLM ou du fournisseur, tel quel, ou
 * l'erreur propre à la sonde, traduite, suivie de son détail technique éventuel ; null si le modèle a répondu.
 */
export function texteErreurSonde(
  sonde: { error: string | null; errorCode: string | null },
  traduire: (code: CodeErreurSonde, valeurs: { secondes: number }) => string,
): string | null {
  if (!sonde.errorCode) return sonde.error;
  const texte = traduire(sonde.errorCode as CodeErreurSonde, { secondes: PROBE_TIMEOUT_MS / 1000 });
  return sonde.error ? `${texte} (${sonde.error})` : texte;
}
