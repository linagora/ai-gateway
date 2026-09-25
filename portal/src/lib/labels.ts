import type { DataLevel, PolicyCheckId, RequestStatus } from "./policy";

/** Libellés affichés (interface en français). */
export const LEVEL_LABELS: Record<DataLevel, string> = {
  N1: "N1 — Public",
  N2: "N2 — Interne",
  N3: "N3 — Confidentiel",
  EXP: "Expérimental (bêta)",
};

export const LEVEL_DESCRIPTIONS: Record<DataLevel, string> = {
  N1: "Informations publiques ou destinées à l'être : code open source, documentation publique, veille.",
  N2: "Informations internes non publiques, sans données personnelles sensibles.",
  N3: "Données clients, personnelles (RGPD), RH, finance, contrats, secrets, NDA, secteur public.",
  EXP: "Modèles en bêta, à essayer avec des données publiques uniquement : sans garantie de service, ils peuvent changer ou être retirés sans préavis. Clé dédiée, limitée aux modèles expérimentaux.",
};

export const STATUS_LABELS: Record<RequestStatus, string> = {
  SOUMISE: "Soumise",
  A_COMPLETER: "À compléter",
  APPROUVEE: "Approuvée",
  REFUSEE: "Refusée",
  ANNULEE: "Annulée",
  CLE_EMISE: "Clé émise",
  EXPIREE: "Expirée",
  REVOQUEE: "Révoquée",
};

export const CHECK_LABELS: Record<PolicyCheckId, string> = {
  membre_equipe: "Le demandeur est membre de l'équipe",
  modeles_presents: "Au moins un modèle est demandé",
  modeles_equipe: "Les modèles sont autorisés pour l'équipe",
  niveau_modeles: "Les modèles acceptent le niveau de données déclaré",
  modeles_visibles: "Les modèles sont visibles au catalogue",
};

export const KIND_LABELS = { CLE: "Clé d'API", ADHESION_EQUIPE: "Adhésion à une équipe" } as const;

export const HOSTING_LABELS = { INTERNE: "Interne", UE: "UE", HORS_UE: "Hors UE" } as const;
