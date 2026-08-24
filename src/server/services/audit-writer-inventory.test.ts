import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const householdWriterFiles = [
  "activities.ts",
  "appearance.ts",
  "backups.ts",
  "calendar.ts",
  "export.ts",
  "household-leave.ts",
  "households.ts",
  "integrations.ts",
  "invites.ts",
  "notification-preferences.ts",
  "platform-backup-recovery.ts",
  "unit-preferences.ts"
];

const platformWriterFiles = [
  "platform-authority.ts",
  "platform-backup-recovery.ts",
  "platform-owner-binding.ts"
];

function sourceFor(fileName: string) {
  return readFileSync(fileURLToPath(new URL(`./${fileName}`, import.meta.url)), "utf8");
}

describe("audit writer inventory", () => {
  it("routes every inventoried household writer through the centralized contract", () => {
    for (const fileName of householdWriterFiles) {
      const source = sourceFor(fileName);
      expect(source, fileName).toContain("writeAudit(");
      expect(source, fileName).not.toContain(".auditEvent.create(");
    }
  });

  it("routes every inventoried platform writer through the content-free platform contract", () => {
    for (const fileName of platformWriterFiles) {
      const source = sourceFor(fileName);
      expect(source, fileName).toContain("writePlatformAudit(");
      expect(source, fileName).not.toContain(".platformAuditEvent.create(");
    }
  });
});
