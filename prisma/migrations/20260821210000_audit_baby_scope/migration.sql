BEGIN;

ALTER TABLE "AuditEvent" ADD COLUMN "babyId" TEXT;
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_householdId_babyId_fkey"
  FOREIGN KEY ("householdId", "babyId")
  REFERENCES "Baby" ("householdId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
ALTER TABLE "AuditEvent" VALIDATE CONSTRAINT "AuditEvent_householdId_babyId_fkey";
CREATE INDEX "AuditEvent_householdId_babyId_createdAt_idx" ON "AuditEvent"("householdId", "babyId", "createdAt");

COMMIT;
