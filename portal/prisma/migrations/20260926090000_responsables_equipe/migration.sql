-- Responsables d'équipe (F-54, spécification #35) : tenus par le portail, les « admins d'équipe » de LiteLLM étant
-- une fonction Enterprise (ADR 0001).
CREATE TABLE "TeamManager" (
    "teamId" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "designatedBy" TEXT NOT NULL,
    "designatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamManager_pkey" PRIMARY KEY ("teamId","uid")
);

CREATE INDEX "TeamManager_uid_idx" ON "TeamManager"("uid");
