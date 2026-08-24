import { handleError, ok } from "@/server/http";
import { exportHouseholdAuditCsv, listBabySafetyHistory, listHouseholdAuditEvents } from "@/server/services/audit-reader";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const search = new URL(request.url).searchParams;
    const babyId = search.get("babyId");
    if (babyId) return ok(await listBabySafetyHistory(babyId));
    if (search.get("format") === "csv") {
      return new Response(await exportHouseholdAuditCsv(), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="cubby-audit.csv"'
        }
      });
    }
    const rawLimit = search.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    return ok(await listHouseholdAuditEvents({ limit, cursor: search.get("cursor") ?? undefined }));
  } catch (error) {
    return handleError(error);
  }
}
