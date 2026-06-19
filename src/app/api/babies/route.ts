import { ok, handleError } from "@/server/http";
import { addBaby, listBabies } from "@/server/services/households";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return ok(await listBabies());
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    return ok(await addBaby(await request.json()));
  } catch (error) {
    return handleError(error);
  }
}
