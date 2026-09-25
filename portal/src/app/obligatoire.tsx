/** Marque d'un champ obligatoire : une petite étoile rouge ; l'attribut required l'annonce aux lecteurs d'écran. */
export function Obligatoire() {
  return (
    <span className="obligatoire" aria-hidden="true">
      *
    </span>
  );
}
