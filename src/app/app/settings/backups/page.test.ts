import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("labels manual export history as preparation rather than confirmed receipt", () => {
  const source = readFileSync("src/app/app/settings/backups/page.tsx", "utf8");
  expect(source).toContain('record.kind === "export" && record.status === "complete"');
  expect(source).toContain("Export prepared");
  expect(source).toContain("Download receipt is not confirmed");
});
