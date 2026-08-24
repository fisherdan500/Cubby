import { prisma } from "@/lib/db/prisma";
import { getEffectiveHouseholdContext, requirePermission } from "@/server/auth/context";
import { describeActivity } from "@/lib/activity-format";
import { listActivitiesForContext } from "@/server/services/activities";
import { writeAudit } from "@/server/services/audit";
import { lockActorForWrite } from "@/server/services/mutation-locks";

function csvValue(value: unknown) {
  if (value === null || value === undefined) return "";
  const stringValue = value instanceof Date ? value.toISOString() : String(value);
  return `"${stringValue.replaceAll('"', '""')}"`;
}

export async function activityCsv() {
  const ctx = await getEffectiveHouseholdContext();
  requirePermission(ctx, "export.create");
  return prisma.$transaction(async (tx) => {
    const lockedCtx = await lockActorForWrite(tx, ctx);
    requirePermission(lockedCtx, "export.create");
    const activities = await listActivitiesForContext(lockedCtx, tx);
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
        describeActivity(activity),
        activity.notes
      ].map(csvValue);
    });

    await writeAudit(lockedCtx, {
      action: "export.csv",
      entityType: "household",
      entityId: lockedCtx.householdId
    }, tx);

    return [headers.map(csvValue).join(","), ...rows.map((row) => row.join(","))].join("\n");
  });
}

export async function activitySpreadsheet() {
  const csv = await activityCsv();
  return csv
    .split("\n")
    .map((line) =>
      line
        .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
        .map((value) => value.replace(/^"|"$/g, "").replaceAll('""', '"'))
        .join("\t")
    )
    .join("\n");
}
