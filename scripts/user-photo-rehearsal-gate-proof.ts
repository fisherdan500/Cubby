/**
 * Mutation proof for the user_photo slice.
 *
 * A green suite only means the tests did not fail; it does not mean they would have failed had the
 * source been wrong. Each sabotage below breaks one specific protection and the suite must go red.
 * A survivor is a hole in the tests, not a success.
 *
 * Run: npx tsx scripts/user-photo-gate-proof.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

type Sabotage = {
  what: string;
  file: string;
  from: string;
  to: string;
};

const root = process.cwd();
const ATT = "src/server/services/attachments.ts";
const FMT = "src/server/services/backup-format.ts";
const BKP = "src/server/services/backups.ts";
const POL = "src/domain/attachments.ts";

const sabotages: Sabotage[] = [
  {
    what: "delivery: serve a picture of a member who left the household",
    file: ATT,
    from: '{ postId: null, type: "user_photo", member: { deletedAt: null, disabledAt: null } }',
    to: '{ postId: null, type: "user_photo" }'
  },
  {
    what: "delivery: serve a picture of a disabled (suspended) member",
    file: ATT,
    from: 'member: { deletedAt: null, disabledAt: null } }\n    ]',
    to: 'member: { deletedAt: null } }\n    ]'
  },
  {
    what: "claim: let anyone set another person's picture",
    file: ATT,
    from: "        // Only the member who staged these bytes may claim them.\n        createdByMemberId: memberId",
    to: "        createdByMemberId: undefined"
  },
  {
    what: "claim: stop retiring the previous picture, leaving two available",
    file: ATT,
    from: 'data: { state: "deleted", deletedAt: now, purgeAfter: attachmentPurgeAfter(now), deletedByMemberId: memberId }',
    to: 'data: { deletedByMemberId: memberId }'
  },
  {
    what: "claim: let a removed or disabled membership gain a new picture",
    file: ATT,
    from: '      where: { id: memberId, householdId: ctx.householdId, disabledAt: null, deletedAt: null },',
    to: '      where: { id: memberId, householdId: ctx.householdId },'
  },
  {
    what: "claim: drop the kill switch on the claim path",
    file: ATT,
    from: "  if (!attachmentTypeEnabled(USER_TYPE, options.enabled)) throw new Error(\"attachment_type_unavailable\");\n  const now = options.now ?? new Date();\n  const memberId = ctx.memberId;",
    to: "  const now = options.now ?? new Date();\n  const memberId = ctx.memberId;"
  },
  {
    what: "backup: let a photo claim both a member and a post as owner",
    file: FMT,
    from: "if (owners !== 1 || (postOwned && photo.position === null) || (!postOwned && photo.position !== null)) {",
    to: "if (owners === 0 || (postOwned && photo.position === null)) {"
  },
  {
    what: "backup: collide two members' pictures into one uniqueness key",
    file: FMT,
    from: ': photo.babyId != null ? `baby:${photo.babyId}` : `member:${(photo.memberEmail ?? "").toLowerCase()}`',
    to: ': `baby:${photo.babyId}`'
  },
  {
    what: "backup: accept a picture naming a member the file does not carry",
    file: FMT,
    from: 'return !members.has((item.memberEmail ?? "").toLowerCase());',
    to: "return false;"
  },
  {
    what: "restore: land a profile picture as a feed photo",
    file: BKP,
    from: 'type: memberOwned ? "user_photo" : babyOwned ? "baby_photo" : "feed_photo",',
    to: 'type: babyOwned ? "baby_photo" : "feed_photo",'
  },
  {
    what: "restore: drop member ownership, orphaning the picture",
    file: BKP,
    from: "        babyId,\n        memberId,\n        activatedAt",
    to: "        babyId,\n        memberId: null,\n        activatedAt"
  },
  {
    what: "restore: accept a picture whose member this household does not have",
    file: BKP,
    from: "const owner = memberOwned ? memberId : babyOwned ? babyId : postId;",
    to: "const owner = babyOwned ? babyId : postId ?? true;"
  },
  {
    what: "export: leave profile pictures out of the backup entirely",
    file: BKP,
    from: '{ type: "user_photo", postId: null, member: { deletedAt: null, disabledAt: null } }',
    to: '{ type: "user_photo", postId: null, member: { deletedAt: null, disabledAt: null }, id: "never" }'
  },
  {
    what: "kill switch: stop honouring an override that turns the type off",
    file: POL,
    from: "user_photo: true",
    to: "user_photo: false"
  }
];

const suites = [
  "src/server/services/user-photo-staging.test.ts",
  "src/server/services/user-photo-delivery.test.ts",
  "src/server/services/user-photo-backup-format.test.ts",
  "src/server/services/user-photo-attachment-migration.test.ts",
  "src/domain/user-photo-policy.test.ts",
  "src/server/services/backups.test.ts",
  "src/server/services/backup-format.test.ts",
  "src/server/services/attachments.test.ts"
];

function suiteIsGreen(): boolean {
  try {
    execFileSync("npx", ["vitest", "run", ...suites], { cwd: root, stdio: "pipe", shell: true, timeout: 600_000 });
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const originals = new Map<string, string>();
  for (const file of new Set(sabotages.map((s) => s.file))) {
    originals.set(file, readFileSync(file, "utf8"));
  }
  const restoreAll = () => {
    for (const [file, text] of originals) writeFileSync(file, text);
  };

  console.log("baseline (must be green before any sabotage means anything)");
  if (!suiteIsGreen()) {
    console.log("FAIL baseline is already red; fix that before trusting this proof");
    process.exit(1);
  }
  console.log("PASS baseline green\n");

  let caught = 0;
  const survivors: string[] = [];
  for (const s of sabotages) {
    const original = originals.get(s.file)!;
    // Files in this repo are mixed CRLF/LF, so match against whatever this file actually uses
    // rather than assuming; a silently non-matching anchor would fake a "caught" result.
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const from = s.from.replace(/\n/g, eol);
    const occurrences = original.split(from).length - 1;
    if (occurrences !== 1) {
      restoreAll();
      console.log(`FAIL sabotage anchor matched ${occurrences} times, cannot apply cleanly: ${s.what}`);
      process.exit(1);
    }
    writeFileSync(s.file, original.replace(from, s.to.replace(/\n/g, eol)));
    const green = suiteIsGreen();
    restoreAll();
    if (green) {
      survivors.push(s.what);
      console.log(`SURVIVED  ${s.what}`);
    } else {
      caught += 1;
      console.log(`caught    ${s.what}`);
    }
  }

  restoreAll();
  console.log(`\ncaught ${caught}/${sabotages.length}`);
  if (survivors.length > 0) {
    console.log("\nholes in the tests:");
    for (const s of survivors) console.log(`  - ${s}`);
    process.exit(1);
  }
  console.log("clean pass after restoration:", suiteIsGreen() ? "green" : "RED (restoration failed)");
}

main();
