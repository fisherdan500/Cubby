import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { activityDetailText } from "@/lib/activity-detail";
import { listActivitiesForContext } from "@/server/services/activities";
import { writeAudit } from "@/server/services/audit";
import { lockActorForWrite } from "@/server/services/mutation-locks";

const headers = [
  "id",
  "baby",
  "type",
  "occurredAt",
  "startedAt",
  "endedAt",
  "durationSeconds",
  "timezone",
  "actor",
  "details",
  "notes"
];

function cellValue(value: unknown) {
  if (value === null || value === undefined) return "";
  return value instanceof Date ? value.toISOString() : String(value);
}

/** CSV keeps a value verbatim, including any line breaks, inside quotes. */
function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * A tab-separated row is one line with no tabs inside a value, so both are folded to single spaces.
 * A note with a line break used to be split across rows here, shifting every later column, because
 * the TSV was produced by re-parsing the finished CSV text line by line.
 */
function tabCell(value: string) {
  return value.replace(/\s*\r?\n\s*/g, " ").replaceAll("\t", " ");
}

async function activityExportRows() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "export.create");
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    requirePermission(lockedCtx, "export.create");
    const activities = await listActivitiesForContext(lockedCtx, tx);
    const rows = activities.map((activity) => {
      const isInactiveBaby = Boolean((activity.baby as { inactiveAt?: Date | null }).inactiveAt);
      return [
        activity.id,
        isInactiveBaby ? `${activity.baby.name} (Inactive)` : activity.baby.name,
        activity.type,
        activity.occurredAt,
        activity.startedAt,
        activity.endedAt,
        activity.durationSeconds,
        activity.timezone,
        activity.actorMember.displayName ?? activity.actorMember.user.name,
        // Every declared field, not the dashboard's terse summary: an export used to lose nursing
        // per-side times, a diaper's consistency, a measurement's type and a vaccine's lot and due date.
        activityDetailText(activity),
        activity.notes
      ].map(cellValue);
    });

    await writeAudit(lockedCtx, {
      action: "export.csv",
      entityType: "household",
      entityId: lockedCtx.householdId
    }, tx);

    return rows;
  });
}

export async function activityCsv() {
  const rows = await activityExportRows();
  return [headers.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n");
}

export async function activitySpreadsheet() {
  const rows = await activityExportRows();
  return [headers.map(tabCell).join("\t"), ...rows.map((row) => row.map(tabCell).join("\t"))].join("\n");
}
