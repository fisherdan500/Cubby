import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("labels manual export history as preparation rather than confirmed receipt", () => {
  const source = readFileSync("src/app/app/settings/backups/page.tsx", "utf8");
  expect(source).toContain('record.kind === "export" && record.status === "complete"');
  expect(source).toContain("Export prepared");
  expect(source).toContain("Download receipt is not confirmed");
});

it("points to the whole-system backup, which the app itself cannot make", () => {
  const source = readFileSync("src/app/app/settings/backups/page.tsx", "utf8");
  // A household backup is not a way to move a whole Cubby to a new server, and the tool that is
  // lives only on the server. Saying nothing here reads as "this feature does not exist".
  expect(source).toContain("Moving to a new server");
  expect(source).toContain("scripts/system-backup.sh --maintenance");
  expect(source).toContain("docs/recovery/system-backup.md");
  // The two facts that make a restored system backup work, and that are easy to lose.
  // Asserting ".env" merely appears is too weak: the fact that matters is WHY it must be kept, since
  // a restored install cannot sign anyone in without those keys, and the archive omits them.
  expect(source).toContain("<code>.env</code>");
  expect(source).toContain("holds the keys the restored accounts");
  expect(source).toContain("not inside the archive");
  expect(source).toContain("Cubby is stopped");
});

it("says what a household backup does and does not carry about people", () => {
  const source = readFileSync("src/app/app/settings/backups/page.tsx", "utf8");
  expect(source).toContain("carries no passwords");
  expect(source).toContain("invite again");
});
