import { RafraichissementAuto } from "./rafraichissement-auto";

/** Pages de la gestion : elles se mettent à jour d'elles-mêmes toutes les 30 secondes (ticket #102). */
export default function GestionLayout({ children }: LayoutProps<"/gestion">) {
  return (
    <>
      {children}
      <RafraichissementAuto />
    </>
  );
}
