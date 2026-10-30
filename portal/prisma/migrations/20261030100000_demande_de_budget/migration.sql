-- Demande de budget d'une clé : justification du budget demandé à la création, et demande BUDGET qui relève le plafond d'une clé émise.
ALTER TYPE "RequestKind" ADD VALUE 'BUDGET';

ALTER TABLE "AccessRequest" ADD COLUMN "budgetJustification" TEXT,
ADD COLUMN "raisesBudgetOfRequestId" TEXT;

CREATE INDEX "AccessRequest_raisesBudgetOfRequestId_idx" ON "AccessRequest"("raisesBudgetOfRequestId");
