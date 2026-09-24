import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "better-auth/crypto";

import { prisma } from "@/lib/db/prisma";

// The first account on a fresh install is created by create_platform_owner_account, and nothing else
// may create an account without an invitation. Its guarantees are all in the database - the locks,
// the empty-install check, the code check and the all-or-nothing writes - so they are proven here
// against the real migrations, called as the runtime role the application uses.

const code = "7F3K92QDXB4M0ZHT";
const password = "correct horse battery";

async function resetInstall() {
  // Emptied past the guards and foreign keys, so every case starts as a fresh install.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    for (const table of ["PlatformSettings", "PlatformAuthority", "PlatformSetupCode", "AccountSecurityState", "Account", "User"]) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}"`);
    }
  });
}

async function issueCode(expiresIn = "1 hour") {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "PlatformSetupCode" ("id", "codeDigest", "expiresAt")
     VALUES ('platform', encode(public.digest(convert_to($1, 'UTF8'), 'sha256'), 'hex'), clock_timestamp() + $2::interval)`,
    code,
    expiresIn
  );
}

async function createFirstAccount(input: { code?: string; name?: string; email?: string; passwordHash?: string } = {}) {
  const passwordHash = input.passwordHash ?? (await hashPassword(password));
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL ROLE cubby_runtime");
    const rows = await tx.$queryRaw<Array<{ id: string; ownerUserId: string }>>`
      SELECT "id", "ownerUserId" FROM public."create_platform_owner_account"(
        ${input.code ?? code}, ${input.name ?? "Avery Parent"}, ${input.email ?? "Owner@Example.TEST"}, ${passwordHash}
      )
    `;
    return rows[0];
  });
}

async function counts() {
  const [row] = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`SELECT
    (SELECT COUNT(*) FROM "User") AS users,
    (SELECT COUNT(*) FROM "Account") AS accounts,
    (SELECT COUNT(*) FROM "PlatformAuthority") AS owners,
    (SELECT COUNT(*) FROM "PlatformSetupCode") AS codes`);
  return Object.fromEntries(Object.entries(row!).map(([key, value]) => [key, Number(value)]));
}

beforeEach(resetInstall);

afterAll(async () => {
  await resetInstall();
  await prisma.$disconnect();
});

describe("first-account setup against real PostgreSQL", () => {
  it("lets only the runtime role call the function, never PUBLIC", async () => {
    const [row] = await prisma.$queryRawUnsafe<Array<{ runtime: boolean; publicGrant: boolean }>>(`SELECT
      has_function_privilege('cubby_runtime', '"create_platform_owner_account"(text,text,text,text)', 'EXECUTE') AS runtime,
      EXISTS (
        SELECT 1 FROM pg_proc, aclexplode(pg_proc.proacl) grant_row
        WHERE pg_proc.proname = 'create_platform_owner_account' AND grant_row.grantee = 0
      ) AS "publicGrant"`);
    expect(row).toEqual({ runtime: true, publicGrant: false });
  });

  it("creates a verified owner with a working credential on an empty install, and spends the code", async () => {
    await issueCode();

    const created = await createFirstAccount();

    expect(created?.id).toBe("platform");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: created!.ownerUserId } });
    expect(user).toMatchObject({ email: "owner@example.test", name: "Avery Parent", emailVerified: true });
    const account = await prisma.account.findFirstOrThrow({ where: { userId: user.id, providerId: "credential" } });
    // The stored hash is the one sign-in will check, so the owner can sign in with the password chosen.
    expect(await verifyPassword({ hash: account.password!, password })).toBe(true);
    const [security] = await prisma.$queryRawUnsafe<Array<{ credentialVersion: number; sessionSecurityVersion: number }>>(
      `SELECT "credentialVersion", "sessionSecurityVersion" FROM "AccountSecurityState" WHERE "userId" = $1`,
      user.id
    );
    expect(security).toEqual({ credentialVersion: 1, sessionSecurityVersion: 1 });
    await expect(prisma.platformAuthority.findUnique({ where: { id: "platform" } })).resolves.toMatchObject({ ownerUserId: user.id });
    await expect(prisma.platformSettings.findUnique({ where: { id: "platform" } })).resolves.toMatchObject({
      householdCreationMode: "closed",
      allowPublicRegistration: false
    });
    expect(await counts()).toEqual({ users: 1, accounts: 1, owners: 1, codes: 0 });
  });

  it.each([
    { label: "a wrong code", expiresIn: "1 hour", input: { code: "0000000000000000" }, codesLeft: 1 },
    { label: "an expired code", expiresIn: "-1 second", input: {}, codesLeft: 1 },
    { label: "no code at all", expiresIn: null, input: {}, codesLeft: 0 }
  ])("refuses $label and leaves nothing behind", async ({ expiresIn, input, codesLeft }) => {
    if (expiresIn) await issueCode(expiresIn);

    await expect(createFirstAccount(input)).rejects.toThrow("platform_setup_code_invalid");
    expect(await counts()).toEqual({ users: 0, accounts: 0, owners: 0, codes: codesLeft });
  });

  it("refuses once any account exists, even with a valid code", async () => {
    await issueCode();
    await prisma.user.create({ data: { name: "Early Account", email: "early@example.test", emailVerified: false } });

    await expect(createFirstAccount()).rejects.toThrow("platform_setup_install_not_empty");
    expect(await counts()).toEqual({ users: 1, accounts: 0, owners: 0, codes: 1 });
  });

  it("refuses a second setup after an owner is bound", async () => {
    await issueCode();
    await createFirstAccount();
    await issueCode();

    await expect(createFirstAccount({ email: "second@example.test" })).rejects.toThrow("platform_owner_already_bound");
    expect(await counts()).toEqual({ users: 1, accounts: 1, owners: 1, codes: 1 });
  });

  it.each([
    ["a password where its hash belongs", { passwordHash: password }],
    ["a blank name", { name: "   " }],
    ["a malformed email", { email: "not-an-email" }]
  ] as const)("refuses %s without spending the code", async (_label, input) => {
    await issueCode();

    await expect(createFirstAccount(input)).rejects.toThrow("platform_setup_account_invalid");
    expect(await counts()).toEqual({ users: 0, accounts: 0, owners: 0, codes: 1 });
  });

  it("lets exactly one of two simultaneous setups win", async () => {
    await issueCode();

    const results = await Promise.allSettled([
      createFirstAccount({ email: "first@example.test" }),
      createFirstAccount({ email: "second@example.test" })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [rejected] = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(String(rejected?.reason)).toMatch(/platform_owner_already_bound|platform_setup_install_not_empty|platform_setup_code_invalid/);
    expect(await counts()).toEqual({ users: 1, accounts: 1, owners: 1, codes: 0 });
  });
});
