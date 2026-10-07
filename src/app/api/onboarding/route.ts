import { authorizedRequestOrigin, ok, handleError } from "@/server/http";
import { onboardingRequestSchema } from "@/lib/validation/onboarding";
import {
  SELECTED_HOUSEHOLD_MEMBER_COOKIE,
  selectedHouseholdCookieOptions
} from "@/server/auth/context";
import { createOnboardingHousehold } from "@/server/services/households";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const requestOrigin = authorizedRequestOrigin(request);
    const data = await createOnboardingHousehold(onboardingRequestSchema.parse(await request.json()));
    const response = ok(data.household);
    response.cookies.set(
      SELECTED_HOUSEHOLD_MEMBER_COOKIE,
      data.memberId,
      selectedHouseholdCookieOptions(requestOrigin)
    );
    return response;
  } catch (error) {
    return handleError(error);
  }
}
