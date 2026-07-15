ALTER TABLE "Baby" ADD COLUMN "inactiveAt" TIMESTAMP(3);

CREATE INDEX "Baby_inactiveAt_idx" ON "Baby"("inactiveAt");
