/**
 * Every stored column of a feed post travels in a backup, or says why not.
 *
 * A backup is the family's only protection against losing years of their own record, and the dangerous
 * failure is the silent one: a column nobody declares is simply dropped, restores as empty, and no
 * count differs, so nothing reports it. An equivalent guard already exists for activity detail columns;
 * this is the same guard for posts, added because FeedPost.activityId -- the link that makes an entry
 * and its photo one moment -- was omitted from the backup format and would have un-combined every
 * such moment on restore, with the photo quietly disappearing from the entry it belonged to.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/** The scalar columns Postgres actually stores for a model, excluding relations and back-references. */
function storedColumns(model: string): string[] {
  const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8");
  const body = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m").exec(schema)?.[1] ?? "";
  const columns: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("//") || text.startsWith("@@")) continue;
    const [name, type] = text.split(/\s+/);
    if (!name || !type) continue;
    // A relation field names another model; a list is never a stored column.
    if (/^[A-Z]/.test(type.replace(/[?[\]]/g, "")) && !/^(DateTime|String|Int|Boolean|Float|Decimal|BigInt|Bytes|Json)$/.test(type.replace(/[?[\]]/g, ""))) continue;
    if (type.includes("[]")) continue;
    columns.push(name);
  }
  return columns;
}

/** The keys the backup format actually declares for a post, read from the format itself. */
function carriedKeys(): string[] {
  const source = readFileSync(resolve(process.cwd(), "src/server/services/backup-format.ts"), "utf8");
  const body = /const feedPostSchema = z\s*\.object\(\{([\s\S]*?)\}\)/.exec(source)?.[1] ?? "";
  const keys: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("//")) continue;
    // Either `name,` shorthand or `name: <zod>`.
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[,:]/.exec(text);
    if (match) keys.push(match[1]!);
  }
  if (keys.length === 0) throw new Error("could not read feedPostSchema; this guard would silently pass");
  return keys;
}

/** What the backup format carries for a post today, derived from the format rather than restated. */
const carried = carriedKeys();

/**
 * Columns a backup deliberately does not carry, each with the reason it is safe to drop.
 *
 * Household and author identity are re-established by the restore itself, and lifecycle bookkeeping
 * describes the old row rather than the family's content.
 */
const deliberatelyNotCarried: Record<string, string> = {
  householdId: "the restore writes its own household",
  authorMemberId: "memberships are not in backups; the author travels as a name",
  externalAuthorName: "carried as authorName",
  createdAt: "bookkeeping of the old row, not family content",
  updatedAt: "bookkeeping of the old row, not family content",
  editedAt: "bookkeeping of the old row, not family content",
  deletedAt: "a removed post is not exported at all",
  deletedByMemberId: "a removed post is not exported at all"
};

describe("a feed post in a backup", () => {
  it("reads the real schema, so this guard cannot quietly check nothing", () => {
    // The key list is parsed from source. If that parse ever truncated, the guard would pass
    // while checking almost nothing, so pin keys that must always be there.
    expect(carried).toEqual(expect.arrayContaining(["id", "body", "occurredAt", "authorName"]));
  });

  it("carries every stored column, or documents why not", () => {
    const missing = storedColumns("FeedPost")
      .filter((column) => !carried.includes(column))
      .filter((column) => !(column in deliberatelyNotCarried));

    // A column nobody declares is dropped from every backup and lost on restore, silently. Carry it in
    // the backup format, or give it a reason above.
    expect(missing).toEqual([]);
  });

  it("refuses a backup whose photo post points at an entry the backup does not contain", () => {
    // Every other carried reference is checked this way. An unchecked one restores as a link to
    // nothing, which the database would reject mid-restore and leave the family with a failed
    // recovery instead of a clear refusal up front.
    const source = readFileSync(resolve(process.cwd(), "src/server/services/backup-format.ts"), "utf8");
    const dangling = /const dangling =([\s\S]*?);\r?\n/.exec(source)?.[1] ?? "";

    expect(dangling).toMatch(/feedPosts[\s\S]*?activityId/);
  });

  it("exports the entry link only when that entry is exported too", () => {
    // Entries are exported only while live, but a photo post survives its entry being deleted. If the
    // export carried the link anyway, the payload would name an entry it does not contain -- and the
    // dangling-reference check would then refuse the family's own backup, so deleting one logged entry
    // would stop the household backing up at all.
    const source = readFileSync(resolve(process.cwd(), "src/server/services/backups.ts"), "utf8");
    const mapping = /feedPosts: feedPosts\.map\(\(post\) => \(\{([\s\S]*?)\}\)\)/.exec(source)?.[1] ?? "";
    expect(mapping).not.toBe("");

    // The link must be conditioned on the entry being present, not copied unconditionally.
    expect(mapping).toMatch(/activityId: [^,\n]*(exportedActivityIds|has\(|\?)/);
  });

  it("carries the entry a photo post belongs to", () => {
    // Without this the entry and its photo come back as two separate moments and the entry's Photos
    // section is empty -- the family opens the feed they photographed and the picture is gone.
    expect(carried).toContain("activityId");
  });
});
