import { handleError, ok } from "@/server/http";
import { getHouseholdBrowserOperationPartition } from "@/server/services/browser-operation-partition";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await getHouseholdBrowserOperationPartition());
  } catch (error) {
    return handleError(error);
  }
}
