-- CreateEnum
CREATE TYPE "DataLevel" AS ENUM ('N1', 'N2', 'N3');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('SOUMISE', 'A_COMPLETER', 'APPROUVEE', 'REFUSEE', 'ANNULEE', 'CLE_EMISE', 'EXPIREE', 'REVOQUEE');

-- CreateEnum
CREATE TYPE "RequestKind" AS ENUM ('CLE', 'ADHESION_EQUIPE');

-- CreateEnum
CREATE TYPE "KeyType" AS ENUM ('PERSONNELLE', 'SERVICE');

-- CreateTable
CREATE TABLE "CatalogEntry" (
    "modelName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "useCases" TEXT,
    "category" TEXT,
    "hosting" TEXT NOT NULL,
    "dataLevel" "DataLevel" NOT NULL,
    "visible" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "CatalogEntry_pkey" PRIMARY KEY ("modelName")
);

-- CreateTable
CREATE TABLE "AccessRequest" (
    "id" TEXT NOT NULL,
    "kind" "RequestKind" NOT NULL,
    "requesterUid" TEXT NOT NULL,
    "requesterEmail" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "teamAlias" TEXT NOT NULL,
    "dataLevel" "DataLevel",
    "models" TEXT[],
    "justification" TEXT NOT NULL,
    "project" TEXT,
    "keyType" "KeyType",
    "requestedBudget" DECIMAL(65,30),
    "requestedDays" INTEGER,
    "approvedModels" TEXT[],
    "approvedBudget" DECIMAL(65,30),
    "budgetDuration" TEXT,
    "approvedDays" INTEGER,
    "rpmLimit" INTEGER,
    "tpmLimit" INTEGER,
    "status" "RequestStatus" NOT NULL DEFAULT 'SOUMISE',
    "decidedBy" TEXT,
    "decisionComment" TEXT,
    "decidedAt" TIMESTAMP(3),
    "keyAlias" TEXT,
    "keyTokenId" TEXT,
    "keyIssuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUid" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "details" JSONB NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AccessRequest_requesterUid_idx" ON "AccessRequest"("requesterUid");

-- CreateIndex
CREATE INDEX "AccessRequest_status_idx" ON "AccessRequest"("status");
