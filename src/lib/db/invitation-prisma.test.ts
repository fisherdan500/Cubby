import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ PrismaClient: vi.fn() }));
vi.mock("@prisma/client", () => ({ PrismaClient: mocks.PrismaClient }));

const clients = [
  ["@/lib/db/invitation-prisma", "INVITATION_DATABASE_URL", "cubby_invitation_runtime", "invitation_database_unavailable"],
  ["@/lib/db/invitation-expiry-prisma", "INVITATION_EXPIRY_DATABASE_URL", "cubby_invitation_expiry_worker", "invitation_expiry_database_unavailable"],
  ["@/lib/db/invitation-maintenance-prisma", "INVITATION_MAINTENANCE_DATABASE_URL", "cubby_invitation_maintenance_worker", "invitation_maintenance_database_unavailable"]
] as const;

const originalNodeEnv = process.env.NODE_ENV;
const originalValues = new Map(clients.map(([, environment]) => [environment, process.env[environment]]));

afterEach(() => {
  vi.resetModules();
  mocks.PrismaClient.mockReset();
  if (originalNodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
  else Reflect.set(process.env, "NODE_ENV", originalNodeEnv);
  for (const [, environment] of clients) {
    const value = originalValues.get(environment);
    if (value === undefined) Reflect.deleteProperty(process.env, environment);
    else process.env[environment] = value;
  }
});

describe("invitation database clients", () => {
  it.each(clients)("requires an exact password-bearing %s principal", async (modulePath, environment, role, failure) => {
    Reflect.set(process.env, "NODE_ENV", "production");
    process.env[environment] = `postgresql://cubby_runtime:password@private-host/cubby`;
    await expect(import(modulePath)).rejects.toThrow(failure);

    vi.resetModules();
    process.env[environment] = `postgresql://${role}@private-host/cubby`;
    await expect(import(modulePath)).rejects.toThrow(failure);
  });

  it.each(clients)("configures %s only with its validated URL", async (modulePath, environment, role) => {
    Reflect.set(process.env, "NODE_ENV", "production");
    const url = `postgresql://${role}:password@private-host/cubby`;
    process.env[environment] = url;

    await import(modulePath);

    expect(mocks.PrismaClient).toHaveBeenCalledWith(expect.objectContaining({ datasourceUrl: url }));
  });
});
