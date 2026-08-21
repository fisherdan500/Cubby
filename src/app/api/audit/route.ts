import { handleError, ok } from "@/server/http";
import { listHouseholdAuditEvents } from "@/server/services/audit-reader";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await listHouseholdAuditEvents());
  } catch (error) {
    return handleError(error);
  }
}
