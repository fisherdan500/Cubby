import { activitySpreadsheet } from "@/server/services/export";
import { handleError } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const body = await activitySpreadsheet();
    return new Response(body, {
      headers: {
        "content-type": "text/tab-separated-values; charset=utf-8",
        "content-disposition": `attachment; filename="cubby-activities-${new Date().toISOString().slice(0, 10)}.tsv"`
      }
    });
  } catch (error) {
    return handleError(error);
  }
}
