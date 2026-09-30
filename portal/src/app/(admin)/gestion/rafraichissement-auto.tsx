"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Intervalle du rafraîchissement automatique de la gestion, en millisecondes (ticket #102). */
const INTERVALLE = 30_000;

/**
 * Rafraîchissement automatique de la gestion (ticket #102) : toutes les 30 secondes, le portail refait le rendu de la
 * page (file, listes, pastilles) sans la recharger ni perdre ce qui est saisi. Il attend la fin d'une saisie ; il se met
 * en pause quand l'onglet est caché, et rafraîchit la page aussitôt au retour sur l'onglet, puis de nouveau 30
 * secondes plus tard.
 */
export function RafraichissementAuto() {
  const router = useRouter();
  useEffect(() => {
    let minuterie = 0;
    const rafraichir = () => {
      if (document.visibilityState === "visible" && !saisieEnCours()) router.refresh();
    };
    const programmer = () => {
      window.clearInterval(minuterie);
      minuterie = window.setInterval(rafraichir, INTERVALLE);
    };
    const auRetour = () => {
      if (document.visibilityState !== "visible") return;
      rafraichir();
      programmer();
    };
    programmer();
    document.addEventListener("visibilitychange", auRetour);
    return () => {
      window.clearInterval(minuterie);
      document.removeEventListener("visibilitychange", auRetour);
    };
  }, [router]);
  return null;
}

/**
 * Une saisie est en cours : un champ a le focus, ou le focus est dans un panneau ouvert (confirmation, fiche d'une
 * intégration). Un panneau ouvert d'office, où personne n'agit, n'empêche pas la mise à jour.
 */
function saisieEnCours(): boolean {
  const actif = document.activeElement;
  if (actif instanceof HTMLInputElement || actif instanceof HTMLTextAreaElement || actif instanceof HTMLSelectElement) return true;
  return actif?.closest("details[open]") != null;
}
