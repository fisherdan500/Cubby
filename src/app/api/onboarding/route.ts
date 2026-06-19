import { ok, handleError } from "@/server/http";
import { createOnboardingHousehold } from "@/server/services/households";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const data = await createOnboardingHousehold(await request.json());
    return ok(data);
  } catch (error) {
    return handleError(error);
  }
}
