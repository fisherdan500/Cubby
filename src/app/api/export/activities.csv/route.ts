import { activityCsv } from "@/server/services/export";
import { handleError } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const csv = await activityCsv();
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="cubby-activities.csv"'
      }
    });
  } catch (error) {
    return handleError(error);
  }
}
