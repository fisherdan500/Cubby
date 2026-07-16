import { describe, expect, it } from "vitest";

import {
  assertMigrationFailureContract,
  cleanupResultFailed,
  cleanupTemporaryPaths,
  parseImmutableImageId,
  selectMigrationPrefix
} from "./backup-recovery-rehearsal";

describe("update rehearsal migration prefix", () => {
  it("selects the exact fixed baseline and all lexically ordered migrations through it", () => {
    expect(selectMigrationPrefix([
      "20260714191000_reversible_member_suspension",
      "20260714220000_reversible_baby_inactivity",
      "20260716024000_automated_backup_storage_metadata"
    ])).toEqual([
      "20260714191000_reversible_member_suspension",
      "20260714220000_reversible_baby_inactivity"
    ]);
  });

  it("rejects an empty migration list", () => {
    expect(() => selectMigrationPrefix([])).toThrow("update_rehearsal_migration_order_invalid");
  });

  it("rejects a missing fixed baseline", () => {
    expect(() => selectMigrationPrefix([
      "20260714191000_reversible_member_suspension",
      "20260716024000_automated_backup_storage_metadata"
    ])).toThrow("update_rehearsal_baseline_missing");
  });

  it("rejects duplicate migration names", () => {
    expect(() => selectMigrationPrefix([
      "20260714220000_reversible_baby_inactivity",
      "20260714220000_reversible_baby_inactivity"
    ])).toThrow("update_rehearsal_migration_duplicate");
  });

  it("rejects unexpectedly reordered migration input", () => {
    expect(() => selectMigrationPrefix([
      "20260714220000_reversible_baby_inactivity",
      "20260714191000_reversible_member_suspension"
    ])).toThrow("update_rehearsal_migration_order_invalid");
  });
});

describe("update rehearsal immutable image identity", () => {
  it("accepts only a full content-addressed image ID", () => {
    const imageId = `sha256:${"a".repeat(64)}`;
    expect(parseImmutableImageId(`${imageId}\n`)).toBe(imageId);
  });

  it.each(["", "a".repeat(64), "sha256:abc", `sha256:${"g".repeat(64)}`])(
    "rejects non-immutable image output %#",
    (value) => {
      expect(() => parseImmutableImageId(value)).toThrow("rehearsal_app_image_id_invalid");
    }
  );
});

describe("update rehearsal migration failure contract", () => {
  const valid = {
    error: undefined,
    status: 1,
    output: "cubby_startup phase=migration status=failed",
    containerState: {
      status: "exited",
      exitCode: 1,
      healthStatus: "unhealthy",
      healthExitCodes: [1]
    }
  };

  it("accepts only an exited migration failure with no successful health probe", () => {
    expect(() => assertMigrationFailureContract(valid)).not.toThrow();
  });

  it.each([
    ["spawn error", { error: new Error("spawn failed") }],
    ["zero docker-run exit", { status: 0 }],
    ["missing migration marker", { output: "migration failed" }],
    ["server started", { output: "cubby_startup phase=migration status=failed\ncubby_startup phase=server status=starting" }],
    ["running container", { containerState: { ...valid.containerState, status: "running" } }],
    ["zero container exit", { containerState: { ...valid.containerState, exitCode: 0 } }],
    ["missing healthcheck", { containerState: { ...valid.containerState, healthStatus: "none" } }],
    ["healthy status", { containerState: { ...valid.containerState, healthStatus: "healthy" } }],
    ["health probe never ran", { containerState: { ...valid.containerState, healthExitCodes: [] } }],
    ["successful health probe", { containerState: { ...valid.containerState, healthExitCodes: [1, 0] } }]
  ])("rejects %s", (_label, override) => {
    expect(() => assertMigrationFailureContract({ ...valid, ...override })).toThrow(
      "update_rehearsal_migration_failure_contract_invalid"
    );
  });
});

describe("update rehearsal cleanup contract", () => {
  it("accepts only a successful cleanup process", () => {
    expect(cleanupResultFailed({ error: undefined, status: 0 })).toBe(false);
  });

  it.each([
    { error: new Error("spawn failed"), status: null },
    { error: undefined, status: null },
    { error: undefined, status: 1 }
  ])("fails closed for %#", (result) => {
    expect(cleanupResultFailed(result)).toBe(true);
  });

  it("attempts every temporary path when an earlier removal fails", () => {
    const attempted: string[] = [];
    const failed = cleanupTemporaryPaths(["first", "second"], (path) => {
      attempted.push(path);
      if (path === "first") throw new Error("remove failed");
    });

    expect(failed).toBe(true);
    expect(attempted).toEqual(["first", "second"]);
  });
});
