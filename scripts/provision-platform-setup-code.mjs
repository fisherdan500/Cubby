import { PrismaClient } from "@prisma/client";
import { createHash, randomInt } from "node:crypto";

// While no platform owner exists, each start issues a fresh one-time setup code and prints it to the
// container log. Whoever can read the host's logs can claim ownership at /setup; a visitor who merely
// reached the site first cannot, which is why the first account is never promoted automatically.
// Only the SHA-256 digest is stored. Once an owner exists, any leftover code is deleted and nothing is
// printed.
//
// Crockford base32 (no I, L, O or U) keeps the code unambiguous to read aloud or retype; 16 characters
// give 80 bits, far beyond online guessing and beyond offline guessing of the stored digest.
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const codeLength = 16;
const validHours = 24;
const lockId = 1_807_633_529;

const prisma = new PrismaClient({ log: [] });
try {
  const code = Array.from({ length: codeLength }, () => alphabet[randomInt(alphabet.length)]).join("");
  const issued = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
    const [authority] = await tx.$queryRaw`SELECT "id" FROM "PlatformAuthority" WHERE "id" = 'platform'`;
    if (authority) {
      await tx.$executeRaw`DELETE FROM "PlatformSetupCode"`;
      return false;
    }
    const digest = createHash("sha256").update(code, "utf8").digest("hex");
    await tx.$executeRaw`
      INSERT INTO "PlatformSetupCode" ("id", "codeDigest", "expiresAt", "createdAt")
      VALUES ('platform', ${digest}, clock_timestamp() + make_interval(hours => ${validHours}::integer), clock_timestamp())
      ON CONFLICT ("id") DO UPDATE
      SET "codeDigest" = EXCLUDED."codeDigest", "expiresAt" = EXCLUDED."expiresAt", "createdAt" = EXCLUDED."createdAt"
    `;
    return true;
  });
  if (issued) {
    const display = code.match(/.{4}/g).join("-");
    process.stdout.write(
      [
        "cubby_startup phase=platform_setup_code status=issued",
        "",
        "  Cubby has no platform owner yet.",
        "  Sign in (or create the first account), open /setup and enter this one-time code:",
        "",
        `      ${display}`,
        "",
        `  It works once and expires in ${validHours} hours. Restarting Cubby issues a new code.`,
        ""
      ].join("\n") + "\n"
    );
  } else {
    process.stdout.write("cubby_startup phase=platform_setup_code status=not_needed\n");
  }
} catch {
  process.stderr.write("cubby_startup phase=platform_setup_code status=failed\n");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
