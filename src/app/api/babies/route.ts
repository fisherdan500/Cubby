import { ok, handleError } from "@/server/http";
import { addBaby, listBabies, submitCreateBabyBrowserOperation } from "@/server/services/households";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await listBabies({ includeInactive: true }));
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const raw = await request.json() as Record<string, unknown>;
    if (typeof raw.operationId === "string" && raw.operationId.startsWith("bmo_")) {
      const result = await submitCreateBabyBrowserOperation(raw);
      return ok(result, { status: result.status === "pending" ? 202 : result.status === "expired" ? 410 : 200 });
    }
    return ok(await addBaby(raw));
  } catch (error) {
    return handleError(error);
  }
}
