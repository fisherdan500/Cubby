import { Prisma } from "@prisma/client";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/server/auth/session";
import { writePlatformAudit } from "@/server/services/audit";
import { PLATFORM_SINGLETON_ID } from "@/server/services/platform-constants";

// Matches scripts/provision-platform-setup-code.mjs: 16 Crockford base32 characters, shown in groups
// of four. People retype codes, so spaces, dashes and lower case are accepted and normalized away.
const setupCodePattern = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const claimSchema = z.object({ code: z.string().max(64) }).strict();

const firstAccountSchema = z
  .object({
    code: z.string().max(64),
    name: z.string().max(200),
    email: z.string().max(320),
    password: z.string().max(1024)
  })
  .strict();
// Better Auth's own credential bounds, so the first account could equally have been made by it.
const firstAccountFields = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128)
});

const CLAIM_ERROR_CODES = [
  "platform_owner_already_bound",
  "platform_setup_code_invalid",
  "platform_setup_account_ineligible",
  "platform_setup_install_not_empty",
  "platform_setup_account_invalid"
] as const;

function claimError(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
    return new Error("platform_setup_retry");
  }
  const message = error instanceof Error ? error.message : "";
  const known = CLAIM_ERROR_CODES.find((candidate) => message.includes(candidate));
  return known ? new Error(known) : error;
}

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
    throw claimError(error);
  }
}

/** Whether a signed-out visitor may create the first account: no platform owner and no account at all. */
export async function isFirstAccountSetupAvailable() {
  return (await firstAccountSetupBlocker()) === null;
}

async function firstAccountSetupBlocker() {
  const [authority, anyUser] = await Promise.all([
    prisma.platformAuthority.findUnique({ where: { id: PLATFORM_SINGLETON_ID }, select: { id: true } }),
    prisma.user.findFirst({ select: { id: true } })
  ]);
  if (authority) return "platform_owner_already_bound";
  if (anyUser) return "platform_setup_install_not_empty";
  return null;
}

/**
 * Creates the install's first account with the one-time setup code and makes it the verified platform
 * owner, for a fresh install where nobody can sign in yet. It needs no session, so it is the one place
 * an account can be made without an invitation, and create_platform_owner_account allows it only while
 * no platform owner and no account exist: the account, its credential, the binding and the spent code
 * are written together or not at all. General sign-up stays closed.
 */
export async function createPlatformOwnerAccount(raw: unknown) {
  const input = firstAccountSchema.parse(raw);
  const code = normalizePlatformSetupCode(input.code);
  if (!setupCodePattern.test(code)) throw new Error("platform_setup_code_invalid");
  const fields = firstAccountFields.safeParse(input);
  if (!fields.success) throw new Error("platform_setup_account_invalid");
  const { name, email, password } = fields.data;
  // The endpoint is open to anyone, so the deliberately slow hash runs only while setup is possible at
  // all; the database still decides, under its locks, whether this request gets to finish it.
  const blocker = await firstAccountSetupBlocker();
  if (blocker) throw new Error(blocker);
  const passwordHash = await hashPassword(password);

  try {
    return await prisma.$transaction(
      async (tx) => {
        const [created] = await tx.$queryRaw<Array<{ id: string; ownerUserId: string }>>`
          SELECT "id", "ownerUserId" FROM public."create_platform_owner_account"(${code}, ${name}, ${email}, ${passwordHash})
        `;
        if (!created?.ownerUserId) throw new Error("platform_setup_code_invalid");
        await writePlatformAudit({
          actorUserId: created.ownerUserId,
          action: "platform.owner.setup_claim",
          entityType: "platform_authority",
          entityId: PLATFORM_SINGLETON_ID,
          source: "setup_code_first_account"
        }, tx);
        return { ownerUserId: created.ownerUserId };
      },
      // Read committed on purpose: the function serializes with advisory locks, and each statement it
      // runs after taking them must see what a concurrent setup committed. A serializable snapshot taken
      // before the wait would not, and the losing request would fail on a conflict instead of learning
      // that an owner now exists.
      { isolationLevel: "ReadCommitted", maxWait: 10_000, timeout: 20_000 }
    );
  } catch (error) {
    throw claimError(error);
  }
}
