BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ActivityLog"
    WHERE "pausedSeconds" < 0
       OR (
         "timerState" IN ('running', 'paused', 'stopped')
         AND "startedAt" IS NULL
       )
       OR (
         "timerState" = 'paused'
         AND (
           "pausedAt" IS NULL
           OR "pausedAt" < "startedAt"
         )
       )
       OR (
         "timerState" <> 'paused'
         AND "pausedAt" IS NOT NULL
       )
       OR (
         "timerState" = 'none'
         AND "pausedSeconds" <> 0
       )
       OR (
         "timerState" IN ('running', 'paused')
         AND ("endedAt" IS NOT NULL OR "durationSeconds" IS NOT NULL)
       )
       OR (
         "timerState" IN ('running', 'paused')
         AND "pausedSeconds" > 0
         AND "startedAt" > CURRENT_TIMESTAMP
       )
       OR (
         "timerState" = 'stopped'
         AND (
           "endedAt" IS NULL
           OR "durationSeconds" IS NULL
           OR "durationSeconds" < 0
           OR "durationSeconds" + "pausedSeconds"
              > GREATEST(
                ROUND(EXTRACT(EPOCH FROM "endedAt")) - ROUND(EXTRACT(EPOCH FROM "startedAt")),
                ROUND(EXTRACT(EPOCH FROM ("endedAt" - "startedAt")))
              )
         )
       )
  ) THEN
    RAISE EXCEPTION 'activity_timer_pause_interval_preflight_failed';
  END IF;
END $$;

ALTER TABLE "ActivityLog"
  ADD COLUMN "pauseTrackingStartedAt" TIMESTAMP(3),
  ADD COLUMN "pauseTrackingBaselineSeconds" INTEGER;

CREATE TABLE "ActivityTimerPauseInterval" (
  "id" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityTimerPauseInterval_pkey" PRIMARY KEY ("id")
);

UPDATE "ActivityLog"
SET "pauseTrackingStartedAt" = "startedAt",
    "pauseTrackingBaselineSeconds" = 0
WHERE "pausedSeconds" = 0
  AND "startedAt" IS NOT NULL
  AND (
    "timerState" IN ('running', 'paused')
    OR (
      "timerState" = 'stopped'
      AND "endedAt" IS NOT NULL
      AND "durationSeconds" IS NOT NULL
      AND "durationSeconds" = ROUND(EXTRACT(EPOCH FROM "endedAt")) - ROUND(EXTRACT(EPOCH FROM "startedAt"))
    )
  );

UPDATE "ActivityLog"
SET "pauseTrackingStartedAt" = CURRENT_TIMESTAMP,
    "pauseTrackingBaselineSeconds" = "pausedSeconds"
WHERE "pausedSeconds" > 0
  AND "timerState" IN ('running', 'paused');

INSERT INTO "ActivityTimerPauseInterval" (
  "id",
  "activityId",
  "startedAt",
  "endedAt"
)
SELECT
  'pause_backfill_' || md5("id" || ':' || "pausedAt"::TEXT),
  "id",
  "pausedAt",
  NULL
FROM "ActivityLog"
WHERE "timerState" = 'paused'
  AND "pausedAt" IS NOT NULL;

ALTER TABLE "ActivityTimerPauseInterval"
  ADD CONSTRAINT "ActivityTimerPauseInterval_activityId_fkey"
  FOREIGN KEY ("activityId") REFERENCES "ActivityLog"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityTimerPauseInterval"
  ADD CONSTRAINT "ActivityTimerPauseInterval_valid_range_check"
  CHECK ("endedAt" IS NULL OR "endedAt" >= "startedAt");

CREATE INDEX "ActivityTimerPauseInterval_activityId_startedAt_idx"
  ON "ActivityTimerPauseInterval"("activityId", "startedAt");

CREATE UNIQUE INDEX "ActivityTimerPauseInterval_one_open_per_activity"
  ON "ActivityTimerPauseInterval"("activityId")
  WHERE "endedAt" IS NULL;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "ActivityTimerPauseInterval"
  ADD CONSTRAINT "ActivityTimerPauseInterval_no_overlap"
  EXCLUDE USING GIST (
    "activityId" WITH =,
    tsrange("startedAt", COALESCE("endedAt", TIMESTAMP 'infinity'), '[)') WITH &&
  );

CREATE FUNCTION "protectActivityTimerPauseIntervalInsert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."endedAt" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM "ActivityLog" activity
       WHERE activity."id" = NEW."activityId"
         AND activity.xmin = txid_current()::text::xid
     ) THEN
    RAISE EXCEPTION 'activity_timer_pause_interval_closed_insert';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ActivityTimerPauseInterval_open_insert"
BEFORE INSERT ON "ActivityTimerPauseInterval"
FOR EACH ROW
EXECUTE FUNCTION "protectActivityTimerPauseIntervalInsert"();

CREATE FUNCTION "protectActivityTimerPauseInterval"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."id" IS DISTINCT FROM NEW."id"
     OR OLD."activityId" IS DISTINCT FROM NEW."activityId"
     OR OLD."startedAt" IS DISTINCT FROM NEW."startedAt"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt"
     OR OLD."endedAt" IS NOT NULL
     OR NEW."endedAt" IS NULL THEN
    RAISE EXCEPTION 'activity_timer_pause_interval_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ActivityTimerPauseInterval_immutable"
BEFORE UPDATE ON "ActivityTimerPauseInterval"
FOR EACH ROW
EXECUTE FUNCTION "protectActivityTimerPauseInterval"();

CREATE FUNCTION "serializeActivityTimerPauseWrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_activity_id TEXT;
  target_activity_ids TEXT[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_activity_ids := ARRAY[NEW."activityId"];
  ELSIF TG_OP = 'DELETE' THEN
    target_activity_ids := ARRAY[OLD."activityId"];
  ELSE
    target_activity_ids := ARRAY[OLD."activityId", NEW."activityId"];
  END IF;

  FOR target_activity_id IN
    SELECT DISTINCT activity_id
    FROM unnest(target_activity_ids) AS ids(activity_id)
    ORDER BY activity_id
  LOOP
    UPDATE "ActivityLog"
    SET "updatedAt" = "updatedAt"
    WHERE "id" = target_activity_id;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ActivityTimerPauseInterval_serialize"
BEFORE INSERT OR UPDATE OR DELETE ON "ActivityTimerPauseInterval"
FOR EACH ROW
EXECUTE FUNCTION "serializeActivityTimerPauseWrite"();

CREATE FUNCTION "assertActivityTimerPauseIntegrity"(target_activity_id TEXT)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  activity "ActivityLog"%ROWTYPE;
  interval_count INTEGER;
  open_count INTEGER;
  open_started_at TIMESTAMP(3);
  closed_pause_seconds BIGINT;
BEGIN
  SELECT * INTO activity
  FROM "ActivityLog"
  WHERE "id" = target_activity_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT
    COUNT(*)::int,
    COUNT(*) FILTER (WHERE "endedAt" IS NULL)::int,
    MAX("startedAt") FILTER (WHERE "endedAt" IS NULL),
    COALESCE(SUM(ROUND(EXTRACT(EPOCH FROM "endedAt")) - ROUND(EXTRACT(EPOCH FROM "startedAt"))) FILTER (WHERE "endedAt" IS NOT NULL), 0)::bigint
  INTO interval_count, open_count, open_started_at, closed_pause_seconds
  FROM "ActivityTimerPauseInterval"
  WHERE "activityId" = target_activity_id;

  IF (activity."timerState" = 'paused' AND open_count <> 1)
     OR (activity."timerState" <> 'paused' AND open_count <> 0)
     OR (activity."timerState" = 'paused' AND activity."pausedAt" IS NULL)
     OR (activity."timerState" = 'paused' AND open_started_at IS DISTINCT FROM activity."pausedAt")
     OR (activity."timerState" <> 'paused' AND activity."pausedAt" IS NOT NULL)
     OR (activity."pausedSeconds" < 0)
     OR (activity."timerState" = 'none' AND activity."pausedSeconds" <> 0)
     OR (
       activity."timerState" IN ('running', 'paused')
       AND (activity."startedAt" IS NULL OR activity."endedAt" IS NOT NULL OR activity."durationSeconds" IS NOT NULL)
     )
     OR (
       activity."timerState" = 'stopped'
       AND (
         activity."startedAt" IS NULL
         OR activity."endedAt" IS NULL
         OR activity."durationSeconds" IS NULL
         OR activity."durationSeconds" < 0
         OR activity."durationSeconds" + activity."pausedSeconds"
            > GREATEST(
              ROUND(EXTRACT(EPOCH FROM activity."endedAt")) - ROUND(EXTRACT(EPOCH FROM activity."startedAt")),
              ROUND(EXTRACT(EPOCH FROM (activity."endedAt" - activity."startedAt")))
            )
       )
     )
     OR (
       activity."timerState" IN ('running', 'paused')
       AND (
         activity."pauseTrackingStartedAt" IS NULL
         OR activity."pauseTrackingBaselineSeconds" IS NULL
       )
     )
     OR (
       activity."timerState" = 'none'
       AND (
         activity."pauseTrackingStartedAt" IS NOT NULL
         OR activity."pauseTrackingBaselineSeconds" IS NOT NULL
       )
     )
     OR (
       activity."timerState" = 'stopped'
       AND activity."pauseTrackingStartedAt" IS NOT NULL
       AND (
         activity."startedAt" IS NULL
         OR activity."endedAt" IS NULL
         OR activity."durationSeconds" IS NULL
         OR activity."durationSeconds" < 0
         OR activity."durationSeconds" + activity."pausedSeconds"
            <> ROUND(EXTRACT(EPOCH FROM activity."endedAt")) - ROUND(EXTRACT(EPOCH FROM activity."startedAt"))
       )
     )
     OR ((activity."pauseTrackingStartedAt" IS NULL) <> (activity."pauseTrackingBaselineSeconds" IS NULL))
     OR activity."pauseTrackingBaselineSeconds" < 0
     OR activity."pauseTrackingBaselineSeconds" > activity."pausedSeconds"
     OR (activity."pauseTrackingStartedAt" IS NULL AND interval_count <> 0)
     OR (
       activity."pauseTrackingStartedAt" IS NOT NULL
       AND (
         activity."startedAt" IS NULL
         OR activity."pauseTrackingStartedAt" < activity."startedAt"
         OR (activity."endedAt" IS NOT NULL AND activity."pauseTrackingStartedAt" > activity."endedAt")
       )
     )
     OR (
       activity."pauseTrackingStartedAt" IS NOT NULL
       AND closed_pause_seconds
         <> activity."pausedSeconds" - activity."pauseTrackingBaselineSeconds"
     ) THEN
    RAISE EXCEPTION 'activity_timer_pause_integrity_failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "ActivityTimerPauseInterval" pause
    WHERE pause."activityId" = target_activity_id
      AND (
        activity."startedAt" IS NULL
        OR pause."startedAt" < activity."startedAt"
        OR (pause."endedAt" IS NOT NULL AND pause."endedAt" < activity."pauseTrackingStartedAt")
        OR (activity."endedAt" IS NOT NULL AND COALESCE(pause."endedAt", pause."startedAt") > activity."endedAt")
      )
  ) OR EXISTS (
    SELECT 1
    FROM "ActivityTimerPauseInterval" left_pause
    JOIN "ActivityTimerPauseInterval" right_pause
      ON left_pause."activityId" = right_pause."activityId"
     AND left_pause."id" < right_pause."id"
     AND tsrange(left_pause."startedAt", COALESCE(left_pause."endedAt", TIMESTAMP 'infinity'), '[)')
         && tsrange(right_pause."startedAt", COALESCE(right_pause."endedAt", TIMESTAMP 'infinity'), '[)')
    WHERE left_pause."activityId" = target_activity_id
  ) THEN
    RAISE EXCEPTION 'activity_timer_pause_integrity_failed';
  END IF;
END;
$$;

CREATE FUNCTION "enforceActivityTimerPauseIntegrity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'ActivityLog' THEN
    PERFORM "assertActivityTimerPauseIntegrity"(NEW."id");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "assertActivityTimerPauseIntegrity"(OLD."activityId");
  ELSE
    PERFORM "assertActivityTimerPauseIntegrity"(NEW."activityId");
    IF TG_OP = 'UPDATE' AND OLD."activityId" <> NEW."activityId" THEN
      PERFORM "assertActivityTimerPauseIntegrity"(OLD."activityId");
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "ActivityLog_pause_integrity"
AFTER INSERT OR UPDATE ON "ActivityLog"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforceActivityTimerPauseIntegrity"();

CREATE CONSTRAINT TRIGGER "ActivityTimerPauseInterval_pause_integrity"
AFTER INSERT OR UPDATE OR DELETE ON "ActivityTimerPauseInterval"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "enforceActivityTimerPauseIntegrity"();

CREATE FUNCTION "closeActivityTimerPauseInterval"(target_activity_id TEXT, target_ended_at TIMESTAMP)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  closed_count INTEGER;
BEGIN
  PERFORM 1
  FROM public."ActivityLog"
  WHERE "id" = target_activity_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pause_interval_missing';
  END IF;

  UPDATE public."ActivityTimerPauseInterval"
  SET "endedAt" = target_ended_at
  WHERE "activityId" = target_activity_id
    AND "endedAt" IS NULL;
  GET DIAGNOSTICS closed_count = ROW_COUNT;
  IF closed_count <> 1 THEN
    RAISE EXCEPTION 'pause_interval_missing';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION "closeActivityTimerPauseInterval"(TEXT, TIMESTAMP) FROM PUBLIC;

DO $$
DECLARE
  migrated_activity_id TEXT;
BEGIN
  FOR migrated_activity_id IN SELECT "id" FROM "ActivityLog" ORDER BY "id"
  LOOP
    PERFORM "assertActivityTimerPauseIntegrity"(migrated_activity_id);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cubby_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT ON TABLE "ActivityTimerPauseInterval" TO cubby_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION "closeActivityTimerPauseInterval"(TEXT, TIMESTAMP) TO cubby_runtime';
  END IF;
END $$;

COMMIT;
