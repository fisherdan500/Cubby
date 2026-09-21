BEGIN;

-- Every page now asks whether this baby has a timer running, so the app shell can offer one-tap stop
-- from anywhere. Without help that question scans a household's whole activity history for a baby:
-- tens of thousands of rows on a multi-year household, to find the nought to three rows that matter.
--
-- A partial index holds only the rows that are actually live, so it stays a handful of entries however
-- long the household has been logging, and it costs nothing to maintain for the ordinary rows that are
-- neither running nor paused.
CREATE INDEX "ActivityLog_active_timers_idx"
  ON "ActivityLog" ("householdId", "babyId", "startedAt" DESC)
  WHERE "timerState" IN ('running', 'paused') AND "deletedAt" IS NULL;

COMMIT;
