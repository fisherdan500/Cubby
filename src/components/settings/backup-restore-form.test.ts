import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./backup-restore-form.tsx", import.meta.url), "utf8");

describe("BackupRestoreForm", () => {
  it("uploads the selected file unchanged through preview then confirmed restore", () => {
    expect(source).toContain('type="file"');
    expect(source).toContain('accept="application/json,.json"');
    expect(source).toContain('body: selectedFile');
    expect(source).toContain('"/api/backups/restore/preview"');
    expect(source).toContain('"x-cubby-restore-confirmation"');
    expect(source).toContain('"x-cubby-backup-checksum"');
  });

  it("renders preview counts, exclusions, legacy warning, and accessible status", () => {
    expect(source).toContain("legacyPartial");
    expect(source).toContain("exclusions");
    expect(source).toContain("Object.entries(preview.counts)");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("Type the current household name exactly");
  });
});
