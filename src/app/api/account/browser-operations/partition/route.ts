import { handleError, ok } from "@/server/http";
import { getAccountBrowserOperationPartition } from "@/server/services/browser-operation-partition";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await getAccountBrowserOperationPartition());
  } catch (error) {
    return handleError(error);
  }
}
