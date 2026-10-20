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
  // Asserting ".env" merely appears is too weak: the fact that matters is WHY it is worth keeping,
  // which is the receipts a mismatched restore drops, and that the archive omits it.
  expect(source).toContain("<code>.env</code>");
  // The .env warning must state the real consequence. The measurably wrong claim is that accounts
  // or «redacted-vault-secret»s depend on it - they do not, a «redacted-vault-secret» carries its own salt. What keeping it buys
  // is the invitation setup receipts, which a restore under a different .env has to drop.
  expect(source).toContain("drops only the invitation setup");
  expect(source).toContain("not inside the archive");
  expect(source).toContain("Cubby is stopped");
});

it("says where the whole-system backup runs, where it lands, and how to put it back", () => {
  const source = readFileSync("src/app/app/settings/backups/page.tsx", "utf8");
  // Naming a command without saying WHERE to type it, where the file appears, or how to restore it
  // reads as an instruction the reader has already failed to follow. A household that has to move
  // servers is usually doing it under pressure, and "see the docs in the checkout" is unreachable
  // advice for someone who is looking at a web page rather than a terminal.
  expect(source).toContain("In a terminal");
  expect(source).toContain("docker-compose.yml");
  // Where the archive actually appears, so it can be found and copied.
  expect(source).toContain("docker-data/system-backups");
  expect(source).toContain("Copy that file to the new server");
  // The restore half: previously the page named the backup command but never its counterpart.
  expect(source).toContain("scripts/system-restore.sh");
  expect(source).toContain("--confirm-empty-install");
  // The precondition that makes a restore refuse, stated before it is hit rather than after.
  expect(source).toContain("needs an empty install");
  // This panel is not an upload form, and nothing on this page accepts the archive.
  expect(source).toContain("nothing to upload here");
  // Why the household backup above is not the tool for this job.
  expect(source).toContain("must already have accounts");
});

it("says what a household backup does and does not carry about people", () => {
  const source = readFileSync("src/app/app/settings/backups/page.tsx", "utf8");
  expect(source).toContain("carries no passwords");
  expect(source).toContain("invite again");
});
