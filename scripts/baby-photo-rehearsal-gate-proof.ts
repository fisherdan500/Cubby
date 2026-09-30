/**
 * Proves the baby-photo gate can FAIL. A gate that has only ever been green certifies nothing: it
 * may assert something the database enforces anyway, or nothing at all.
 *
 * Each mutation removes one protection the gate exists to prove, runs the real runner, and requires
 * a NONZERO exit. Then the original bytes are restored and a clean run must exit zero. Both halves
 * are required - a gate that passes on sabotaged code is useless, and so is one that fails on clean
 * code. Caught/survived is decided by the EXIT CODE, never by parsing the runner's output: Vitest
 * writes ANSI colour escapes between the summary label and its counts, so output patterns silently
 * score every mutation as zero failures.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const migration = resolve(root, "prisma/migrations/20260930120100_baby_photo_attachment_ownership/migration.sql");

type Mutation = {
  name: string;
  what: string;
  find: string;
  replace: string;
};

const mutations: Mutation[] = [
  {
    name: "one-photo-per-baby index dropped",
    what: "without it a household can hold two served photos for the same baby",
    find: `CREATE UNIQUE INDEX "Attachment_one_available_baby_photo"`,
    replace: `CREATE INDEX "Attachment_one_available_baby_photo"`
  },
  {
    name: "unique index widened to every state",
    what: "scoping it to live rows only is what lets a replaced photo stay recoverable",
    find: `WHERE "type" = 'baby_photo' AND "state" = 'available';`,
    replace: `WHERE "type" = 'baby_photo';`
  },
  {
    name: "composite foreign key reduced to one column",
    what: "a single-column key lets a photo name a baby in another household",
    find: `FOREIGN KEY ("householdId", "babyId")\n  REFERENCES "Baby" ("householdId", "id")`,
    replace: `FOREIGN KEY ("babyId")\n  REFERENCES "Baby" ("id")`
  },
  {
    name: "ownership disjointness check removed",
    what: "without it a baby photo can be owned by a post, or a feed photo by a baby",
    find: `ALTER TABLE "Attachment"\n  ADD CONSTRAINT "Attachment_baby_photo_parent"`,
    replace: `ALTER TABLE "Attachment"\n  ADD CONSTRAINT "Attachment_baby_photo_parent_disabled"`
  },
  {
    name: "served-photo-has-a-baby check removed",
    what: "without it a baby photo can go live owned by nothing at all",
    find: `ADD CONSTRAINT "Attachment_available_baby_photo_has_baby"`,
    replace: `ADD CONSTRAINT "Attachment_available_baby_photo_has_baby_disabled"`
  },
  {
    name: "lifecycle check left requiring a post for every type",
    what: "the original wording makes a baby photo unable to leave staging at all",
    find: `AND CASE WHEN "type" = 'baby_photo'\n          THEN "babyId" IS NOT NULL AND "postId" IS NULL AND "position" IS NULL\n          ELSE "postId" IS NOT NULL AND "position" IS NOT NULL\n        END`,
    replace: `AND "postId" IS NOT NULL AND "position" IS NOT NULL`
  },
  {
    name: "lifecycle check relaxed for every type",
    what: "dropping the post requirement outright lets a feed photo go live with no post",
    find: `AND CASE WHEN "type" = 'baby_photo'\n          THEN "babyId" IS NOT NULL AND "postId" IS NULL AND "position" IS NULL\n          ELSE "postId" IS NOT NULL AND "position" IS NOT NULL\n        END`,
    replace: `AND TRUE`
  }
];

function runGate() {
  const result = spawnSync("npm", ["run", "verify:baby-photo"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  return result.status ?? 1;
}

function main() {
  const original = readFileSync(migration, "utf8");
  const results: { name: string; caught: boolean }[] = [];

  try {
    for (const mutation of mutations) {
      const mutated = original.replace(mutation.find, mutation.replace);
      if (mutated === original) {
        throw new Error(`baby_photo_mutation_anchor_missing: ${mutation.name}`);
      }
      writeFileSync(migration, mutated);
      const status = runGate();
      const caught = status !== 0;
      results.push({ name: mutation.name, caught });
      console.log(`${caught ? "CAUGHT  " : "SURVIVED"}  ${mutation.name} - ${mutation.what}`);
      writeFileSync(migration, original);
    }
  } finally {
    writeFileSync(migration, original);
  }

  const cleanStatus = runGate();
  console.log(`CLEAN ${cleanStatus === 0 ? "PASS" : "FAIL"} after restore`);

  const survived = results.filter((entry) => !entry.caught);
  console.log(`\n${results.length - survived.length}/${results.length} mutations caught`);
  if (survived.length > 0 || cleanStatus !== 0) {
    console.log("GATE_PROOF_FAILED");
    process.exitCode = 1;
    return;
  }
  console.log("GATE_PROOF_PASSED");
}

main();
