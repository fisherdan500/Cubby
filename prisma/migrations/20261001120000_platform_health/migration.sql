-- Backup and storage health for the platform owner. scripts/system-backup.sh records each run here
-- through the database superuser; the application only reads the runs, and keeps one row per problem
-- it has emailed the owner about, so an ongoing problem is repeated once a day rather than every hour.

CREATE TABLE "SystemBackupRun" (
    "id" TEXT NOT NULL DEFAULT (gen_random_uuid())::text,
    "status" TEXT NOT NULL,
    "archiveName" TEXT,
    "byteSize" BIGINT,
    "households" INTEGER,
    "accounts" INTEGER,
    "photos" INTEGER,
    "failure" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemBackupRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SystemBackupRun_status_check" CHECK ("status" IN ('succeeded', 'failed')),
    -- A failure is one of the script's own fixed sentences, never a path or command output.
    CONSTRAINT "SystemBackupRun_failure_check" CHECK ("failure" IS NULL OR char_length("failure") <= 200)
);

CREATE INDEX "SystemBackupRun_recordedAt_idx" ON "SystemBackupRun"("recordedAt");

CREATE TABLE "PlatformHealthAlert" (
    "key" TEXT NOT NULL,
    "activeSince" TIMESTAMP(3) NOT NULL,
    "lastSentAt" TIMESTAMP(3),

    CONSTRAINT "PlatformHealthAlert_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "PlatformHealthAlert_key_check" CHECK ("key" ~ '^[a-z_]{1,60}$')
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cubby_runtime') THEN
    EXECUTE 'GRANT SELECT ON TABLE "SystemBackupRun" TO cubby_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "PlatformHealthAlert" TO cubby_runtime';
  END IF;
END $$;
