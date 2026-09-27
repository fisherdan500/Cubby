import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn(), cpSync: vi.fn(), rmSync: vi.fn(), mkdtempSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>(), cpSync: mocks.cpSync, rmSync: mocks.rmSync, mkdtempSync: mocks.mkdtempSync }));
import { runInvitationEmailDeliveryRehearsal } from "../../../scripts/invitation-email-delivery-rehearsal";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mkdtempSync.mockReturnValue(resolve(process.cwd(), "synthetic-rehearsal-not-created"));
  mocks.spawnSync.mockImplementation((_command, args) => ({ status: 0, stdout: args.includes("port") ? "127.0.0.1:54321" : "" }));
});

describe("invitation rehearsal resource lifecycle contract (no real resources)", () => {
  it("waits for TCP readiness rather than the initialization socket", () => {
    expect(readFileSync(resolve(process.cwd(), "scripts/invitation-email-delivery.compose.yml"), "utf8")).toContain("pg_isready -h 127.0.0.1");
  });
  it.each([{ status: 1 }, { status: null, error: new Error("synthetic teardown failure") }])("fails if project disposal fails: %j", (result) => {
    mocks.spawnSync.mockImplementation((_command, args) => args.includes("down") ? result : { status: 0, stdout: args.includes("port") ? "127.0.0.1:54321" : "" });
    expect(() => runInvitationEmailDeliveryRehearsal()).toThrow("invitation_email_delivery_cleanup_failed");
    expect(mocks.rmSync).toHaveBeenCalledTimes(1);
  });
  it("still removes its temporary copy if the disposal call throws", () => {
    mocks.spawnSync.mockImplementation((_command, args) => { if (args.includes("down")) throw new Error("synthetic teardown failure"); return { status: 0, stdout: args.includes("port") ? "127.0.0.1:54321" : "" }; });
    expect(() => runInvitationEmailDeliveryRehearsal()).toThrow("invitation_email_delivery_cleanup_failed");
    expect(mocks.rmSync).toHaveBeenCalledTimes(1);
  });
  it("reports failed temporary-copy cleanup with a fixed code", () => {
    mocks.rmSync.mockImplementation(() => { throw new Error("synthetic private path"); });
    expect(() => runInvitationEmailDeliveryRehearsal()).toThrow("invitation_email_delivery_cleanup_failed");
  });
  it("attempts teardown even when the migration/test lifecycle fails", () => {
    mocks.spawnSync.mockImplementation((_command, args) => ({ status: args.includes("migrate") ? 1 : 0, stdout: args.includes("port") ? "127.0.0.1:54321" : "" }));
    expect(() => runInvitationEmailDeliveryRehearsal()).toThrow("invitation_email_delivery_rehearsal_failed");
    expect(mocks.spawnSync.mock.calls.at(-1)![1]).toEqual(expect.arrayContaining(["down", "--volumes", "--remove-orphans"]));
    expect(mocks.rmSync).toHaveBeenCalledTimes(1);
  });
  it("completes only after successful project and temporary-copy disposal", () => {
    expect(() => runInvitationEmailDeliveryRehearsal()).not.toThrow();
    expect(mocks.spawnSync.mock.calls.at(-1)![1]).toEqual(expect.arrayContaining(["down", "--volumes", "--remove-orphans"]));
    expect(mocks.rmSync).toHaveBeenCalledTimes(1);
  });
});
