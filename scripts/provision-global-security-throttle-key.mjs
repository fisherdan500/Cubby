import { PrismaClient } from "@prisma/client";
import { createHash, timingSafeEqual } from "node:crypto";

const encodedKey = process.env.CUBBY_THROTTLE_KEY;
let keyDigest;
try {
  const key = Buffer.from(encodedKey ?? "", "base64url");
  if (!encodedKey || !/^[A-Za-z0-9_-]{43}$/.test(encodedKey) || key.length !== 32 || !timingSafeEqual(Buffer.from(encodedKey), Buffer.from(key.toString("base64url")))) throw new Error();
  keyDigest = createHash("sha256").update(key).digest();
} catch {
  process.stderr.write("cubby_startup phase=global_security_throttle_key status=failed\n");
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('global-security-throttle-key:v1', 0))`;
    const rows = await tx.$queryRaw`
      SELECT "singletonId", "keyDigest" FROM "GlobalSecurityThrottleKey" WHERE "singletonId"=1 FOR UPDATE
    `;
    const row = rows[0];
    if (!row) {
      await tx.globalSecurityThrottleKey.create({ data: { singletonId: 1, keyDigest } });
    } else {
      const storedDigest = Buffer.from(row.keyDigest);
      if (storedDigest.length !== 32 || !timingSafeEqual(storedDigest, keyDigest)) throw new Error();
      await tx.$executeRaw`UPDATE "GlobalSecurityThrottleKey" SET "verifiedAt"=clock_timestamp() WHERE "singletonId"=1`;
    }
    await tx.$executeRawUnsafe('REVOKE ALL ON TABLE "GlobalSecurityThrottleKey" FROM PUBLIC, cubby_runtime, cubby_auth');
  });
  process.stdout.write("cubby_startup phase=global_security_throttle_key status=succeeded\n");
} catch {
  process.stderr.write("cubby_startup phase=global_security_throttle_key status=failed\n");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
