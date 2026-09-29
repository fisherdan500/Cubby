import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync("src/components/settings/backup-restore-form.tsx", "utf8");

// A restore never grants membership: it recognises people already in this household and reports
// everyone else in members.needInvite. That list is the only way the operator learns who did not come
// across, and Settings promises it is "listed for you to invite again" -- so it has to actually appear.
// The server computed it and the route passed it through, but the form dropped it on the floor.

it("reads the needInvite list from the restore response", () => {
  expect(source).toContain("needInvite");
  // Must be typed on the response, not merely mentioned, or it cannot be read.
  expect(source).toMatch(/members\??:\s*\{[^}]*needInvite/);
});

it("renders each email that needs an invitation", () => {
  // Rendered as a list, keyed per email, so several people are all visible rather than a count.
  expect(source).toMatch(/needInvite\.map\(/);
});

it("says nothing about invitations when everyone was recognised", () => {
  // An empty list must not render an empty heading implying someone is missing.
  expect(source).toMatch(/needInvite\.length\s*(>|\?)/);
});

it("populates the list from the response rather than a constant", () => {
  // A source test that only checks `needInvite` is mentioned would still pass if the setter were wired
  // to an empty array, leaving the operator with no idea who to invite. Pin the data flow itself.
  expect(source).toMatch(/setNeedInvite\(\s*result\.data\.members\?\.needInvite/);
  expect(source).not.toMatch(/setNeedInvite\(\[\]\);[\s\S]{0,120}setMessage\(`Restore complete/);
});
