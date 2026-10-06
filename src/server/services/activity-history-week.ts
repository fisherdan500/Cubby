import { Prisma } from "@prisma/client";
import { HISTORY_PAGE_SIZE } from "@/lib/history-pagination";
import type { HistoryWeek } from "@/lib/history-week";

export function selectHistoryWeekIds(
  database: Pick<Prisma.TransactionClient, "$queryRaw">,
  householdId: string,
  week: Extract<HistoryWeek, { status: "valid" }>,
  filters?: { babyId?: string; type?: string; search?: string },
  cursor?: string
) {
  const pattern = `%${filters?.search}%`;
  const now = new Date();
  return database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH scoped AS (
      SELECT a.*, COALESCE(a."startedAt", a."occurredAt") AS "sleepStart" FROM "ActivityLog" a
      WHERE a."householdId" = ${householdId} AND a."deletedAt" IS NULL
        ${filters?.babyId ? Prisma.sql`AND a."babyId" = ${filters.babyId}` : Prisma.empty}
        ${filters?.type ? Prisma.sql`AND a."type" = ${filters.type}::"ActivityType"` : Prisma.empty}
        ${filters?.search ? Prisma.sql`AND (
          a."notes" ILIKE ${pattern}
          OR EXISTS (SELECT 1 FROM "MilestoneLog" d WHERE d."activityId" = a."id" AND d."title" ILIKE ${pattern})
          OR EXISTS (SELECT 1 FROM "NoteLog" d WHERE d."activityId" = a."id" AND d."text" ILIKE ${pattern})
          OR EXISTS (SELECT 1 FROM "MedicineLog" d WHERE d."activityId" = a."id" AND d."name" ILIKE ${pattern})
          OR EXISTS (SELECT 1 FROM "SupplementLog" d WHERE d."activityId" = a."id" AND d."name" ILIKE ${pattern})
          OR EXISTS (SELECT 1 FROM "VaccineLog" d WHERE d."activityId" = a."id" AND d."name" ILIKE ${pattern})
          OR EXISTS (SELECT 1 FROM "MoodLog" d WHERE d."activityId" = a."id" AND d."mood" ILIKE ${pattern})
          OR EXISTS (SELECT 1 FROM "PlayLog" d WHERE d."activityId" = a."id" AND d."activityName" ILIKE ${pattern})
        )` : Prisma.empty}
    ), intervals AS (
      SELECT scoped.*, CASE
        WHEN "endedAt" IS NOT NULL THEN GREATEST("sleepStart", "endedAt")
        WHEN "timerState" = 'paused' AND "pausedAt" IS NOT NULL THEN GREATEST("sleepStart", "pausedAt")
        WHEN "timerState" IN ('running', 'paused') THEN GREATEST("sleepStart", ${now}::timestamp)
        WHEN "durationSeconds" IS NOT NULL THEN "sleepStart" + "durationSeconds" * INTERVAL '1 second'
        ELSE NULL
      END AS "sleepEnd" FROM scoped
    ), matched AS (
      SELECT "id", "occurredAt" FROM intervals
      WHERE ("type" <> 'sleep' AND "occurredAt" >= ${week.start} AND "occurredAt" < ${week.end})
        OR ("type" = 'sleep' AND "sleepEnd" IS NOT NULL AND "sleepEnd" > "sleepStart"
          AND "sleepStart" < ${week.end} AND "sleepEnd" > ${week.start})
    )
    SELECT m."id" FROM matched m
    ${cursor !== undefined ? Prisma.sql`WHERE (m."occurredAt", m."id") < (
      SELECT c."occurredAt", c."id" FROM matched c WHERE c."id" = ${cursor}
    )` : Prisma.empty}
    ORDER BY m."occurredAt" DESC, m."id" DESC
    LIMIT ${HISTORY_PAGE_SIZE + 1}
  `);
}
