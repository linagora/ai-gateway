import "server-only";
import { addressesFromEnv, mailerFromEnv } from "@/lib/courriel";
import { getDb } from "@/lib/db";
import { getLiteLLM } from "@/lib/litellm/instance";
import { lireIntervalle, superviserModeles } from "@/lib/services/supervision";

/** Premier passage une minute après le démarrage : la base et LiteLLM ont le temps de répondre. */
const PREMIER_PASSAGE_MS = 60_000;

/** Minuterie de la supervision, sur globalThis : un rechargement à chaud de `next dev` ne la démarre pas deux fois. */
const memoire = globalThis as typeof globalThis & { minuterieSupervision?: ReturnType<typeof setInterval> };

/**
 * Supervision des modèles planifiée dans le portail (ticket #142), démarrée une fois au lancement du serveur (src/instrumentation.ts) :
 * un passage toutes les SUPERVISION_INTERVAL_MINUTES minutes, sans cron. Le portail tourne en une seule instance ; deux
 * instances sonderaient chacune les modèles, sans double alerte au-delà d'une course entre deux passages simultanés.
 * Un passage encore en cours (sondes jusqu'à 30 s), lancé par la minuterie, le bouton ou la route interne, n'est pas
 * doublé (superviserModeles). Seuls les modèles en échec et les passages en échec sont journalisés.
 */
export function demarrerSupervision(): void {
  const intervalle = lireIntervalle(process.env.SUPERVISION_INTERVAL_MINUTES);
  if (intervalle === null) {
    console.log("Supervision des modèles : sonde automatique désactivée (SUPERVISION_INTERVAL_MINUTES absent ou hors bornes)");
    return;
  }
  if (memoire.minuterieSupervision) return;

  const passage = async () => {
    try {
      // Dépendances construites ici, et non par getDeps() (src/lib/session.ts), qui charge Auth.js et le contexte des requêtes.
      const rapport = await superviserModeles({
        db: getDb(),
        litellm: getLiteLLM(),
        mailer: mailerFromEnv(),
        adminEmails: addressesFromEnv(process.env.ADMIN_NOTIFICATION_EMAILS),
        portalUrl: process.env.AUTH_URL,
        intervalleMinutes: intervalle,
      });
      for (const [libelle, modeles] of [["en panne", rapport.enPanne], ["dégradés", rapport.degrades]] as const) {
        if (modeles.length > 0) {
          const details = modeles.map((m) => `${m.modelName} (${[m.errorCode, m.error].filter(Boolean).join(" : ")})`);
          console.warn(`Supervision des modèles : ${libelle} : ${details.join(", ")}`);
        }
      }
    } catch (e) {
      console.error(`Supervision des modèles : passage en échec (${e instanceof Error ? e.message : "erreur inconnue"})`);
    }
  };
  memoire.minuterieSupervision = setInterval(passage, intervalle * 60_000);
  setTimeout(passage, PREMIER_PASSAGE_MS);
  console.log(`Supervision des modèles : sonde automatique toutes les ${intervalle} min`);
}
