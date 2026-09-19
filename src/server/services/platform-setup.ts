import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/server/auth/session";
import { writePlatformAudit } from "@/server/services/audit";
import { PLATFORM_SINGLETON_ID } from "@/server/services/platform-constants";

// Matches scripts/provision-platform-setup-code.mjs: 16 Crockford base32 characters, shown in groups
// of four. People retype codes, so spaces, dashes and lower case are accepted and normalized away.
const setupCodePattern = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const claimSchema = z.object({ code: z.string().max(64) }).strict();

const CLAIM_ERROR_CODES = [
  "platform_owner_already_bound",
  "platform_setup_code_invalid",
  "platform_setup_account_ineligible"
] as const;

export function normalizePlatformSetupCode(raw: string) {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

/**
 * Makes the signed-in account the platform owner with the one-time code printed to the container log.
 * The claim itself runs in claim_platform_setup, under the platform lock: it verifies the code's
 * digest and expiry, marks the account verified, binds it with the closed default policy that `bind`
 * creates, and consumes the code, all or nothing. A missing, expired or wrong code is one outcome.
 */
export async function claimPlatformSetup(raw: unknown) {
  const user = await requireUser();
  const code = normalizePlatformSetupCode(claimSchema.parse(raw).code);
  if (!setupCodePattern.test(code)) throw new Error("platform_setup_code_invalid");

  try {
    return await prisma.$transaction(
      async (tx) => {
        const [claimed] = await tx.$queryRaw<Array<{ id: string; ownerUserId: string }>>`
          SELECT "id", "ownerUserId" FROM public."claim_platform_setup"(${user.id}, ${code})
        `;
        if (claimed?.ownerUserId !== user.id) throw new Error("platform_setup_code_invalid");
        await writePlatformAudit({
          actorUserId: user.id,
          action: "platform.owner.setup_claim",
          entityType: "platform_authority",
          entityId: PLATFORM_SINGLETON_ID,
          source: "setup_code"
        }, tx);
        return { ownerUserId: user.id };
      },
      { isolationLevel: "Serializable", maxWait: 10_000, timeout: 20_000 }
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new Error("platform_setup_retry");
    }
    const message = error instanceof Error ? error.message : "";
    const known = CLAIM_ERROR_CODES.find((candidate) => message.includes(candidate));
    throw known ? new Error(known) : error;
  }
}
