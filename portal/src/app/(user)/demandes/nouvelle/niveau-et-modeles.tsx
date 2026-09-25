"use client";

import { useState } from "react";
import { type DataLevel, modelAcceptsLevel } from "@/lib/policy";
import { Obligatoire } from "../../../obligatoire";

/** Niveau proposé, avec son nom et sa définition dans la langue du salarié. */
export interface NiveauPropose {
  niveau: DataLevel;
  libelle: string;
  definition: string;
}

/** Modèle du catalogue, avec le nom de son niveau maximal. */
export interface ModelePropose {
  modelName: string;
  displayName: string;
  dataLevel: DataLevel;
  libelleNiveau: string;
}

/**
 * F-20 : le niveau de confidentialité, puis les seuls modèles qui l'acceptent, selon la règle que le serveur
 * rejoue à l'envoi. Sans niveau choisi, aucun modèle n'est proposé.
 */
export function NiveauEtModeles(props: {
  niveaux: NiveauPropose[];
  modeles: ModelePropose[];
  niveauInitial: DataLevel | null;
  preselection: string[];
  textes: { niveau: string; modeles: string; choisirNiveau: string; aucunModele: string };
}) {
  const [niveau, setNiveau] = useState(props.niveauInitial);
  const [coches, setCoches] = useState(() => new Set(props.preselection));
  const compatibles = niveau ? props.modeles.filter((m) => modelAcceptsLevel(m.dataLevel, niveau)) : [];
  const basculer = (modelName: string, coche: boolean) =>
    setCoches((avant) => {
      const apres = new Set(avant);
      if (coche) apres.add(modelName);
      else apres.delete(modelName);
      return apres;
    });

  return (
    <>
      <fieldset>
        <legend className="font-medium">
          {props.textes.niveau}
          <Obligatoire />
        </legend>
        {props.niveaux.map((n) => (
          <label key={n.niveau} className="font-normal">
            <input type="radio" name="dataLevel" value={n.niveau} required checked={niveau === n.niveau} onChange={() => setNiveau(n.niveau)} /> {n.libelle} —{" "}
            {n.definition}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend className="font-medium">
          {props.textes.modeles}
          <Obligatoire />
        </legend>
        {niveau === null ? (
          <p className="text-sm text-neutral-600">{props.textes.choisirNiveau}</p>
        ) : compatibles.length === 0 ? (
          <p className="text-sm text-neutral-600">{props.textes.aucunModele}</p>
        ) : (
          compatibles.map((m) => (
            <label key={m.modelName} className="font-normal">
              <input
                type="checkbox"
                name="models"
                value={m.modelName}
                checked={coches.has(m.modelName)}
                onChange={(e) => basculer(m.modelName, e.target.checked)}
              />{" "}
              {m.displayName} ({m.libelleNiveau})
            </label>
          ))
        )}
      </fieldset>
    </>
  );
}
