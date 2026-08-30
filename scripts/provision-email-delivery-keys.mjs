import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

const raw = process.env.CUBBY_EMAIL_DELIVERY_KEYRING;
const activeVersion = Number(process.env.CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION);
const entries = [];
try {
  if (!raw || !Number.isSafeInteger(activeVersion) || activeVersion < 1) throw new Error();
  const seen = new Set();
  for (const item of raw.split(",")) {
    const [versionText, encoded] = item.split(":");
    const keyVersion = Number(versionText);
    const key = Buffer.from(encoded ?? "", "base64url");
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || seen.has(keyVersion) || !encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || key.length !== 32) throw new Error();
    seen.add(keyVersion);
    entries.push({ keyVersion, keyDigest: createHash("sha256").update(key).digest(), activeWrite: keyVersion === activeVersion });
  }
  if (!seen.has(activeVersion)) throw new Error();
} catch {
  process.stderr.write("cubby_startup phase=email_delivery_keys status=failed\n");
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.emailDeliveryEncryptionKey.findMany();
    for (const row of existing) {
      const configured = entries.find(({ keyVersion }) => keyVersion === row.keyVersion);
      if (configured && !Buffer.from(row.keyDigest).equals(configured.keyDigest)) throw new Error();
    }
    const referenced = await tx.$queryRaw`
      SELECT DISTINCT "keyVersion" FROM "EmailChangeDelivery"
      WHERE "state" IN ('queued','dispatching','retryable_failed')
    `;
    for (const row of referenced) {
      const configured = entries.find(({ keyVersion }) => keyVersion === row.keyVersion);
      const stored = existing.find(({ keyVersion }) => keyVersion === row.keyVersion);
      if (!configured || !stored || !Buffer.from(stored.keyDigest).equals(configured.keyDigest)) throw new Error();
    }
    for (const entry of entries) {
      await tx.emailDeliveryEncryptionKey.upsert({
        where: { keyVersion: entry.keyVersion },
        create: { ...entry, activeWrite: false },
        update: {}
      });
    }
    // Rotation metadata changes only when the active version changes and every
    // timestamp comes from PostgreSQL, never the host clock.
    await tx.$executeRaw`
      UPDATE "EmailDeliveryEncryptionKey"
      SET "activeWrite"=false,"retiredAt"=COALESCE("retiredAt",clock_timestamp())
      WHERE "keyVersion"<>${activeVersion} AND ("activeWrite"=true OR "retiredAt" IS NULL)
    `;
    await tx.$executeRaw`
      UPDATE "EmailDeliveryEncryptionKey"
      SET "activeWrite"=true,"retiredAt"=NULL
      WHERE "keyVersion"=${activeVersion}
    `;
    await tx.$executeRawUnsafe('REVOKE ALL ON TABLE "EmailDeliveryEncryptionKey" FROM PUBLIC, cubby_runtime');
  });
  process.stdout.write("cubby_startup phase=email_delivery_keys status=succeeded\n");
} catch {
  process.stderr.write("cubby_startup phase=email_delivery_keys status=failed\n");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
