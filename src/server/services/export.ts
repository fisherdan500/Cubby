import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { listActivities } from "@/server/services/activities";
import { writeAudit } from "@/server/services/audit";

function csvValue(value: unknown) {
  if (value === null || value === undefined) return "";
  const stringValue = value instanceof Date ? value.toISOString() : String(value);
  return `"${stringValue.replaceAll('"', '""')}"`;
}

export async function activityCsv() {
  const ctx = await getHouseholdContext();
  requirePermission(ctx, "export.create");
  const activities = await listActivities();
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
    const detail =
      activity.feeding?.mode ??
      activity.diaper?.kind ??
      activity.medicine?.name ??
      activity.milestone?.title ??
      activity.note?.category ??
      "";
    return [
      activity.id,
      activity.baby.name,
      activity.type,
      activity.occurredAt,
      activity.startedAt,
      activity.endedAt,
      activity.durationSeconds,
      activity.timezone,
      activity.actorMember.displayName ?? activity.actorMember.user.name,
      detail,
      activity.notes
    ].map(csvValue);
  });

  await writeAudit(ctx, {
    action: "export.csv",
    entityType: "household",
    entityId: ctx.householdId
  });

  return [headers.map(csvValue).join(","), ...rows.map((row) => row.join(","))].join("\n");
}
