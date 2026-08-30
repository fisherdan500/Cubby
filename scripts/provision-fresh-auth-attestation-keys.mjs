import { PrismaClient } from "@prisma/client";

const configured = process.env.CUBBY_FRESH_AUTH_ATTESTATION_KEYRING;
const activeVersion = Number(process.env.CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION);
const entries = [];
try {
  if (!configured || !Number.isSafeInteger(activeVersion) || activeVersion < 1) throw new Error();
  const seen = new Set();
  for (const item of configured.split(",")) {
    const [versionText, encoded] = item.split(":");
    const keyVersion = Number(versionText);
    const verificationKey = Buffer.from(encoded ?? "", "base64url");
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || seen.has(keyVersion) || !encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || verificationKey.length !== 32) throw new Error();
    seen.add(keyVersion);
    entries.push({ keyVersion, verificationKey, active: true, rotatedAt: keyVersion === activeVersion ? null : new Date() });
  }
  if (!seen.has(activeVersion) || entries.length > 2) throw new Error();
} catch {
  process.stderr.write("cubby_startup phase=fresh_auth_attestation_keys status=failed\n");
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.freshAuthAttestationKey.findMany({ where: { keyVersion: { in: entries.map(({ keyVersion }) => keyVersion) } } });
    if (existing.some((row) => !Buffer.from(row.verificationKey).equals(entries.find(({ keyVersion }) => keyVersion === row.keyVersion).verificationKey))) throw new Error();
    await tx.freshAuthAttestationKey.deleteMany({ where: { keyVersion: { notIn: entries.map(({ keyVersion }) => keyVersion) } } });
    for (const entry of entries) {
      const current = existing.find(({ keyVersion }) => keyVersion === entry.keyVersion);
      await tx.freshAuthAttestationKey.upsert({ where: { keyVersion: entry.keyVersion }, create: entry, update: { active: true, rotatedAt: entry.keyVersion === activeVersion ? null : current?.rotatedAt ?? new Date() } });
    }
    await tx.$executeRawUnsafe('REVOKE ALL ON TABLE "FreshAuthAttestationKey" FROM PUBLIC, cubby_runtime');
    const rows = await tx.freshAuthAttestationKey.findMany({ orderBy: { keyVersion: "asc" } });
    if (rows.length !== entries.length || rows.some((row, index) => row.keyVersion !== entries[index].keyVersion || !Buffer.from(row.verificationKey).equals(entries[index].verificationKey) || !row.active)) throw new Error();
  });
  process.stdout.write("cubby_startup phase=fresh_auth_attestation_keys status=succeeded\n");
} catch {
  process.stderr.write("cubby_startup phase=fresh_auth_attestation_keys status=failed\n");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
