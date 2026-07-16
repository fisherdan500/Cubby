import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./backup-download-button.tsx", import.meta.url), "utf8");

describe("BackupDownloadButton", () => {
  it("uses explicit POST download behavior with accessible pending and error state", () => {
    expect(source).toContain('method: "POST"');
    expect(source).toContain('URL.createObjectURL');
    expect(source).toContain('URL.revokeObjectURL');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('disabled={pending}');
  });
});
