import { describe, expect, it } from "vitest";

const normalRuntimeProbePath = "../../../scripts/p1-3-invitation.normal-runtime-probe.mjs";

async function matches(baseline: unknown, observation: unknown) {
  const { p13InvitationNormalRuntimeMatches } = await import(normalRuntimeProbePath);
  return p13InvitationNormalRuntimeMatches(baseline, observation);
}

const baseline = {
  app: {
    containerId: "app-id",
    imageId: "app-image",
    health: "healthy",
    mounts: [["bind", "", "C:/safe/source", "/run/safe", false]],
    restartCount: 2
  },
  postgres: {
    containerId: "postgres-id",
    imageId: "postgres-image",
    health: "healthy",
    mounts: [["volume", "postgres-data", "C:/safe/volume", "/var/lib/postgresql/data", true]],
    restartCount: 0
  }
};

const observation = {
  app: {
    identity: ["app-id", "app-image", "true", "healthy", "2"],
    mounts: [["bind", "", "C:\\safe\\source", "/run/safe", false]]
  },
  postgres: {
    identity: ["postgres-id", "postgres-image", "true", "healthy", "0"],
    mounts: [["volume", "postgres-data", "C:/safe/volume", "/var/lib/postgresql/data", true]]
  }
};

describe("P1-3 normal-runtime probe", () => {
  it("accepts only an exact field-selected identity, health, restart, and normalized-mount match", async () => {
    expect(await matches(baseline, observation)).toBe(true);
  });

  it("fails closed on every selected field mismatch without requiring an inspect payload", async () => {
    const changed = structuredClone(observation);
    changed.app.identity[2] = "false";
    expect(await matches(baseline, changed)).toBe(false);

    changed.app.identity[2] = "true";
    changed.postgres.mounts[0]![4] = false;
    expect(await matches(baseline, changed)).toBe(false);
  });
});
