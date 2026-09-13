import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  startBackup: vi.fn(),
  startIntegrity: vi.fn(),
  startSproutRetention: vi.fn(),
  startBrowserOperationRetention: vi.fn(),
  startEmailDelivery: vi.fn(),
  startEmailChangeLifecycle: vi.fn(),
  writeFileSync: vi.fn()
}));


vi.mock("@/server/automated-backup-scheduler", () => ({
  startAutomatedBackupScheduler: mocks.startBackup
}));
vi.mock("@/server/integrity-scheduler", () => ({
  startIntegrityScheduler: mocks.startIntegrity
}));
vi.mock("@/server/sprout-source-retention-scheduler", () => ({
  startSproutSourceRetentionScheduler: mocks.startSproutRetention
}));
vi.mock("@/server/browser-operation-retention-scheduler", () => ({
  startBrowserOperationRetentionScheduler: mocks.startBrowserOperationRetention
}));
vi.mock("@/server/email-delivery-scheduler", () => ({
  startEmailDeliveryScheduler: mocks.startEmailDelivery
}));
vi.mock("@/server/email-change-lifecycle-scheduler", () => ({
  startEmailChangeLifecycleScheduler: mocks.startEmailChangeLifecycle
}));

describe("instrumentation", () => {
  const originalRuntime = process.env.NEXT_RUNTIME;
  const originalSentinel = process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL;
  const originalMarker = process.env.CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE;

  afterEach(() => {
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
    if (originalSentinel === undefined) delete process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL;
    else process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL = originalSentinel;
    if (originalMarker === undefined) delete process.env.CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE;
    else process.env.CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE = originalMarker;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("enables the Next.js production instrumentation hook", async () => {
    const config = await readFile(path.join(process.cwd(), "next.config.mjs"), "utf8");
    expect(config).toMatch(/instrumentationHook:\s*true/);
  });

  it("starts enabled scheduler modules only in node runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const { register } = await import("@/instrumentation");
    await register();
    expect(mocks.startBackup).toHaveBeenCalledOnce();
    expect(mocks.startIntegrity).toHaveBeenCalledOnce();
    expect(mocks.startSproutRetention).toHaveBeenCalledOnce();
    expect(mocks.startBrowserOperationRetention).toHaveBeenCalledOnce();
    expect(mocks.startEmailDelivery).toHaveBeenCalledOnce();
    expect(mocks.startEmailChangeLifecycle).toHaveBeenCalledOnce();
  });

  it("advances only the fixed acceptance instrumentation stages", async () => {
    const markerPath = "/run/cubby-acceptance-status/instrumentation-stage";
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL = "1";
    process.env.CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE = markerPath;
    vi.spyOn(process, "getBuiltinModule").mockReturnValue({ writeFileSync: mocks.writeFileSync } as never);
    const { register } = await import("@/instrumentation");
    await register();
    expect(mocks.writeFileSync.mock.calls).toEqual([
      [markerPath, "module_evaluated\n", { encoding: "utf8", flag: "w", mode: 0o600 }],
      [markerPath, "register_entered\n", { encoding: "utf8", flag: "w", mode: 0o600 }],
      [markerPath, "modules_loaded\n", { encoding: "utf8", flag: "w", mode: 0o600 }],
      [markerPath, "automated_backup_started\n", { encoding: "utf8", flag: "w", mode: 0o600 }],
      [markerPath, "integrity_started\n", { encoding: "utf8", flag: "w", mode: 0o600 }],
      [markerPath, "sprout_retention_started\n", { encoding: "utf8", flag: "w", mode: 0o600 }],
      [markerPath, "browser_operation_retention_started\n", { encoding: "utf8", flag: "w", mode: 0o600 }],
      [markerPath, "email_delivery_started\n", { encoding: "utf8", flag: "w", mode: 0o600 }],
      [markerPath, "email_change_lifecycle_started\n", { encoding: "utf8", flag: "w", mode: 0o600 }]
    ]);
  });
});
