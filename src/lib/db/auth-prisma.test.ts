import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ PrismaClient: vi.fn() }));

vi.mock("@prisma/client", () => ({ PrismaClient: mocks.PrismaClient }));

const originalNodeEnv = process.env.NODE_ENV;
const originalAuthDatabaseUrl = process.env.AUTH_DATABASE_URL;

async function loadAuthPrisma() {
  vi.resetModules();
  Reflect.set(process.env, "NODE_ENV", "production");
  return import("@/lib/db/auth-prisma");
}

describe("auth Prisma connection", () => {
  beforeEach(() => {
    mocks.PrismaClient.mockReset();
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
    if (originalAuthDatabaseUrl === undefined) Reflect.deleteProperty(process.env, "AUTH_DATABASE_URL");
    else Reflect.set(process.env, "AUTH_DATABASE_URL", originalAuthDatabaseUrl);
  });

  it("requires a password-bearing cubby_auth connection URL", async () => {
    for (const url of [
      "postgresql://cubby_runtime:password@private-host/cubby",
      "postgresql://cubby_auth@private-host/cubby"
    ]) {
      process.env.AUTH_DATABASE_URL = url;
      await expect(loadAuthPrisma()).rejects.toThrow("auth_database_unavailable");
    }
  });

  it("configures Prisma with the validated cubby_auth URL", async () => {
    const url = "postgresql://cubby_auth:password@private-host/cubby";
    process.env.AUTH_DATABASE_URL = url;

    await loadAuthPrisma();

    expect(mocks.PrismaClient).toHaveBeenCalledWith(expect.objectContaining({ datasourceUrl: url }));
  });
});
