ALTER TABLE "BackupRecord"
  ADD COLUMN "storageFilename" TEXT,
  ADD COLUMN "byteSize" INTEGER;

CREATE UNIQUE INDEX "BackupRecord_storageFilename_key" ON "BackupRecord"("storageFilename");