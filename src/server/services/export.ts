import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { describeActivity } from "@/lib/activity-format";
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
      describeActivity(activity),
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
