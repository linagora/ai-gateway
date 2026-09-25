/**
 * Pastille d'un nombre d'actions en attente, après le libellé d'un lien de menu ; les lecteurs d'écran lisent son
 * libellé (« 2 demandes à valider »). Rien quand il n'y a rien.
 */
export function Pastille({ nombre, libelle }: { nombre: number; libelle: string }) {
  if (nombre === 0) return null;
  return (
    <>
      <span aria-hidden="true" className="ml-1.5 inline-flex min-w-5 items-center justify-center rounded-full bg-linagora px-1.5 text-xs font-semibold text-white">
        {nombre}
      </span>
      <span className="sr-only"> ({libelle})</span>
    </>
  );
}
