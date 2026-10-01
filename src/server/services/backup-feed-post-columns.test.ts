/**
 * What a feed post carries into a backup, and what it must not claim.
 *
 * A backup is the family's only protection against losing years of their own record, and the dangerous
 * failure is the silent one: a column nobody declares is simply dropped, restores as empty, and no
 * count differs, so nothing reports it. An equivalent guard already exists for activity detail columns;
 * this is the same guard for posts, added because FeedPost.activityId -- the link that makes an entry
 * and its photo one moment -- was omitted from the backup format and would have un-combined every
 * such moment on restore, with the photo quietly disappearing from the entry it belonged to.
 *
 * The second half guards the other direction. An entry is exported only while it is live, but a photo
 * post outlives its entry's deletion, so carrying the link unconditionally would make a payload name
 * an entry it does not contain. The validator runs over the export's own output, so that would refuse
 * the household's own backup: deleting one logged entry would stop the family backing up at all.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createV2Backup } from "@/server/services/backup-format";

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
    const bare = type.replace(/[?[\]]/g, "");
    // A relation field names another model; a list is never a stored column.
    if (/^[A-Z]/.test(bare) && !/^(DateTime|String|Int|Boolean|Float|Decimal|BigInt|Bytes|Json)$/.test(bare)) continue;
    if (type.includes("[]")) continue;
    columns.push(name);
  }
  if (columns.length === 0) throw new Error(`could not read model ${model}; this guard would silently pass`);
  return columns;
}

/** The keys the backup format declares for a post, read from the format itself rather than restated. */
function carriedKeys(): string[] {
  const source = readFileSync(resolve(process.cwd(), "src/server/services/backup-format.ts"), "utf8");
  const body = /const feedPostSchema = z\s*\.object\(\{([\s\S]*?)\}\)/.exec(source)?.[1] ?? "";
  const keys: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("//")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*[,:]/.exec(text);
    if (match) keys.push(match[1]!);
  }
  if (keys.length === 0) throw new Error("could not read feedPostSchema; this guard would silently pass");
  return keys;
}

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

/** The smallest payload the backup format accepts, carrying one live entry and one photo post. */
function payloadWithPhotoPost(linkTo: string | null) {
  return {
    household: { name: "Ours" },
    settings: {},
    members: [],
    babies: [{
      id: "baby-1",
      name: "Wren",
      birthDate: "2026-01-01T00:00:00.000Z",
      timezone: "Etc/UTC",
      notes: null,
      inactiveAt: null
    }],
    contacts: [],
    catalogs: [],
    activities: [{
      id: "act-1",
      babyId: "baby-1",
      type: "feeding" as const,
      occurredAt: "2026-10-01T08:00:00.000Z",
      startedAt: null,
      endedAt: null,
      timezone: "Etc/UTC",
      notes: null,
      source: "app",
      externalActorName: null,
      timerState: "none" as const,
      durationSeconds: null,
      pausedAt: null,
      pausedSeconds: 0,
      contactId: null,
      detail: {}
    }],
    calendarEvents: [],
    reminders: [],
    feedPosts: [{
      id: "post-1",
      babyId: "baby-1",
      body: "",
      tags: [],
      occurredAt: "2026-10-01T08:05:00.000Z",
      ...(linkTo === null ? {} : { activityId: linkTo }),
      authorName: "Dad"
    }],
    feedComments: [],
    feedReactions: [],
    feedPhotos: []
  } as Parameters<typeof createV2Backup>[0];
}

describe("a feed post in a backup", () => {
  it("reads the real schema, so this guard cannot quietly check nothing", () => {
    // The key list is parsed from source. If that parse ever truncated, the guard would pass while
    // checking almost nothing, so pin keys that must always be there.
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

  it("carries the entry a photo post belongs to", () => {
    // Without this the entry and its photo come back as two separate moments and the entry's Photos
    // section is empty -- the family opens the feed they photographed and the picture is gone.
    expect(carried).toContain("activityId");
  });

  it("refuses a backup whose photo post names an entry the backup does not contain", () => {
    expect(() => createV2Backup(payloadWithPhotoPost("act-missing"))).toThrow();
  });

  it("accepts the same backup when the entry travels with it", () => {
    expect(() => createV2Backup(payloadWithPhotoPost("act-1"))).not.toThrow();
  });

  it("accepts a photo post with no entry link at all", () => {
    // What the export produces for a photo whose entry was deleted: the picture is kept as an ordinary
    // post, and only the link is dropped.
    expect(() => createV2Backup(payloadWithPhotoPost(null))).not.toThrow();
  });
});
