-- Nom du demandeur, tel que le SSO le donne au dépôt de la demande : les courriels le saluent par son nom.
-- Les demandes plus anciennes n'en ont pas : leurs courriels reprennent l'identifiant.
ALTER TABLE "AccessRequest" ADD COLUMN "requesterName" TEXT;
