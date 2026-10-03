import { describe, expect, it } from "vitest";
import { minimizeAuditPayload, writeAudit } from "@/server/services/audit";

/**
 * The audit contract for renaming yourself, exercised against the REAL writeAudit.
 *
 * own-profile.test.ts spies writeAudit so it can inspect the per-household calls, which means the
 * module that VALIDATES an audit record never runs there. An action missing from the action enum
 * makes writeAudit throw inside the rename's transaction, so the whole rename rolls back and the
 * person sees a 500 with nothing saved - with every other test still green. This file exists so
 * that cannot happen again, and it deliberately does not mock the audit module.
 */

const ACTION = "own_profile.name.update";

function stubDb() {
  const writes: string[] = [];
  return {
    writes,
    db: {
      $executeRaw: async () => { writes.push("lock"); return 0; },
      auditEvent: {
        count: async () => 0,
        findFirst: async () => null,
        create: async () => { writes.push("create"); return {}; }
      },
      auditCheckpoint: { findFirst: async () => null, upsert: async () => ({}) }
    }
  };
}

describe("the rename's audit record", () => {
  it("uses an action the audit trail classifies", async () => {
    // Passed as a bare string, not cast to the action type: a cast would defeat the very check
    // this test exists to make.
    const { db, writes } = stubDb();

    await writeAudit(
      { householdId: "household-1", userId: "user-1", memberId: "member-1" },
      {
        action: ACTION,
        entityType: "user",
        entityId: "user-1",
        after: { changed: ["name"], shownNameFollowed: true }
      },
      db as never
    );

    expect(writes).toContain("create");
  });

  it("refuses to record the name itself", async () => {
    // A person's name is household content, which audit evidence is required to exclude.
    const { db } = stubDb();

    await expect(writeAudit(
      { householdId: "household-1", userId: "user-1", memberId: "member-1" },
      { action: ACTION, entityType: "user", entityId: "user-1", after: { name: "Daniel Fisher" } },
      db as never
    )).rejects.toThrow();
  });

  it("records whether this household's shown name followed the account", () => {
    const action = ACTION as Parameters<typeof minimizeAuditPayload>[0];

    expect(minimizeAuditPayload(action, { changed: ["name"], shownNameFollowed: false }, "after"))
      .toEqual({ changed: ["name"], shownNameFollowed: false });
  });
});
