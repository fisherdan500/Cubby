import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A report fetches a narrowed set of activity relations rather than all sixteen. The hazard is that
 * `buildReportStats` reads detail tables with optional chaining, so a relation it reads but the
 * include forgot arrives as `undefined` and is silently SKIPPED - the report shows a smaller number
 * instead of failing. Typecheck cannot catch it either: `activity.medicine?.name` on a row that was
 * never fetched with `medicine` is a type error only if the row type is narrow, and the statistics
 * accept a union that deliberately tolerates missing window relations.
 *
 * WHAT THIS GUARD ACTUALLY CHECKS, stated narrowly on purpose: a relation read written as
 * `activity.x` or `activity?.x` directly inside buildReportStats must be fetched by the include
 * feeding it. Reads written any other way - a destructured binding, an alias, bracket access, or a
 * helper that takes the row - are NOT visible to this analysis.
 *
 * That gap would make the guard a false comfort, so the reader's SHAPE is pinned too: the tests
 * below fail if buildReportStats destructures the row, indexes it with a string, aliases it, or
 * iterates it under another name, and fail if a second exported reader of the same row type appears.
 * The blind spot is therefore not silent - writing a read this analysis cannot see breaks the build
 * and says which shape to use instead.
 */

/**
 * Normalised to LF. A Windows checkout stores these files with CRLF while CI sees LF, and the
 * patterns below are anchored on line boundaries - left raw, this guard would parse nothing on one
 * platform and silently assert over empty lists.
 */
function readNormalised(url: URL): string {
  return readFileSync(url, "utf8").replace(/\r\n/g, "\n");
}

const reportsSource = readNormalised(new URL("./reports.ts", import.meta.url));
const schemaSource = readNormalised(new URL("../../../prisma/schema.prisma", import.meta.url));

/** A failure to parse reports.ts, kept distinct from a real drift failure so the two never read alike. */
class ParseShapeError extends Error {
  constructor(what: string) {
    super(
      `${what} - reports.ts no longer has the shape this guard parses. This is a PARSE failure, ` +
        "not a report defect: re-read reports-include-drift.test.ts and update the pattern."
    );
  }
}

/** Every one-to-one detail relation declared on ActivityLog, read off the schema. */
function activityLogRelations(): string[] {
  const model = schemaSource.match(/^model ActivityLog \{$([\s\S]*?)^\}$/m);
  if (!model) throw new ParseShapeError("could not find model ActivityLog in prisma/schema.prisma");
  // Anchored to declared model names, because a scalar like `durationSeconds Int?` is
  // indistinguishable from a relation by shape alone - Int looks exactly like a model name.
  const models = new Set([...schemaSource.matchAll(/^model ([A-Z][A-Za-z]*) \{$/gm)].map((m) => m[1]));
  if (models.size === 0) throw new ParseShapeError("could not read any model names from prisma/schema.prisma");
  const relations: string[] = [];
  for (const line of model[1].split("\n")) {
    // `feeding           FeedingLog?` - a nullable relation to a declared model, no attributes.
    const match = line.match(/^\s{2}([a-z][A-Za-z]*)\s+([A-Z][A-Za-z]*)\?\s*$/);
    if (match && models.has(match[2])) relations.push(match[1]);
  }
  return relations;
}

/**
 * The body of a named exported function. Accepts the declaration forms this codebase actually uses,
 * so renaming or converting to an arrow is a parse failure with a clear message rather than a
 * confusing drift report.
 */
function functionBody(name: string): string {
  const forms = [`export function ${name}(`, `export async function ${name}(`, `export const ${name} = (`];
  const starts = forms.map((form) => reportsSource.indexOf(form)).filter((at) => at >= 0);
  if (starts.length === 0) throw new ParseShapeError(`could not find an exported ${name} in reports.ts`);
  const start = Math.min(...starts);
  const end = reportsSource.indexOf("\n}\n", start);
  if (end < 0) throw new ParseShapeError(`could not find the end of ${name}`);
  return reportsSource.slice(start, end);
}

/** The source of a named `X satisfies Prisma.ActivityLogInclude` constant. */
function includeSource(constName: string): string {
  const start = reportsSource.indexOf(`const ${constName} = {`);
  if (start < 0) throw new ParseShapeError(`could not find ${constName} in reports.ts`);
  const end = reportsSource.indexOf("} satisfies", start);
  if (end < 0) throw new ParseShapeError(`could not find the end of ${constName}`);
  return reportsSource.slice(start, end);
}

/**
 * The relation keys of an include. Deliberately not line-anchored: a trailing comment or a
 * one-line object is a formatting choice, and rejecting it would report correct code as drift.
 */
function includeKeys(constName: string): string[] {
  const keys = [...includeSource(constName).matchAll(/([a-z][A-Za-z]*)\s*:\s*true\b/g)].map((m) => m[1]);
  if (keys.length === 0) throw new ParseShapeError(`parsed no relation keys from ${constName}`);
  return keys;
}

/** Relation names read as `activity.x` / `activity?.x` in the given slice. */
function relationsReadIn(body: string, relations: string[]): string[] {
  const read = new Set<string>();
  for (const match of body.matchAll(/\bactivity\??\.([a-z][A-Za-z]*)/g)) {
    if (relations.includes(match[1])) read.add(match[1]);
  }
  return [...read].sort();
}

/** `ActivityType.milk_inventory` names the `milkInventory` relation; most enum members match directly. */
function relationForType(member: string): string {
  return member.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** The source of the one findMany that uses the given include constant. */
function queryUsing(includeName: string): string {
  const at = reportsSource.indexOf(`include: ${includeName},`);
  if (at < 0) throw new ParseShapeError(`no query uses ${includeName}`);
  const from = reportsSource.lastIndexOf("activityLog.findMany(", at);
  if (from < 0) throw new ParseShapeError(`could not find the findMany that uses ${includeName}`);
  return reportsSource.slice(from, at);
}

describe("report include / reader drift", () => {
  const relations = activityLogRelations();
  const stats = functionBody("buildReportStats");
  const windowInclude = includeKeys("reportActivityInclude");
  const historyInclude = includeKeys("historyActivityInclude");
  const readByStats = relationsReadIn(stats, relations);

  it("derives the detail relations from the schema rather than a hand-kept list", () => {
    // Guards the parser itself: if the schema format shifts and this returns nothing, every
    // assertion below would pass vacuously.
    expect(relations).toContain("feeding");
    expect(relations).toContain("medicine");
    expect(relations).toContain("milkInventory");
    expect(relations.length).toBeGreaterThanOrEqual(12);
  });

  it("parses both includes and the whole reader non-vacuously", () => {
    expect(windowInclude.length).toBeGreaterThan(0);
    expect(historyInclude.length).toBeGreaterThan(0);
    // `activity.milestone` is the LAST relation the reader touches, so this proves the body slice
    // spans the entire function. Asserting on an early read would let a truncated slice pass.
    expect(stats).toContain("activity.type");
    expect(stats).toContain("activity.milestone");
    expect(readByStats.length).toBeGreaterThan(0);
  });

  it("reads the activity row only in the shape this analysis can see", () => {
    // The detector recognises `activity.x` and `activity?.x`. These assertions make every other way
    // of reading the row a build failure, so the blind spot cannot be entered silently.
    expect(stats, "iterate the rows as `for (const activity of ...)`").toMatch(
      /for \(const activity of [A-Za-z]+\) \{/
    );
    expect(stats, "do not destructure the activity row - read `activity.x` so drift stays visible").not.toMatch(
      /\}\s*=\s*activity\b/
    );
    expect(stats, "do not index the activity row with a string - read `activity.x`").not.toMatch(
      /\[\s*["']/
    );
    expect(stats, "do not alias the activity row - read `activity.x` directly").not.toMatch(
      /(?:const|let)\s+[A-Za-z_$][\w$]*\s*(?::[^=\n]+)?=\s*activity\s*;/
    );
  });

  it("reads report relations nowhere but through the activity row", () => {
    // A relation read in a helper - `function f(a: {medicine?: ...}) { return a.medicine?.name }` -
    // sits outside buildReportStats and so outside the detector's slice. Pinning the reads to the
    // `activity` identifier file-wide makes that refactor fail loudly instead of going unguarded.
    const offenders = new Set<string>();
    for (const match of reportsSource.matchAll(/\b([A-Za-z_$][\w$]*)\??\.([a-z][A-Za-z]*)\b/g)) {
      const [, holder, property] = match;
      // ActivityType.sleep names an enum member, not a row relation.
      if (holder === "ActivityType" || holder === "activity") continue;
      if (relations.includes(property)) offenders.add(`${holder}.${property}`);
    }
    expect(
      [...offenders],
      "a report relation is read off something other than `activity` - move the read into " +
        "buildReportStats so this guard can see it, or extend the guard deliberately"
    ).toEqual([]);
  });

  it("keeps buildReportStats the only exported reader of a report row", () => {
    // A second exported reader would fall entirely outside this guard's view.
    const readers = [...reportsSource.matchAll(/\bactivities: (?:Stats|Report)Activity\[\]/g)];
    expect(readers, "a new reader of report rows must be covered by this guard too").toHaveLength(1);
  });

  it("fetches every relation the statistics read", () => {
    const missing = readByStats.filter((name) => !windowInclude.includes(name));
    expect(
      missing,
      `buildReportStats reads ${missing.join(", ")} but reportActivityInclude does not fetch ` +
        "it - those rows would arrive undefined and be silently skipped, under-reporting the stat"
    ).toEqual([]);
  });

  it("does not fetch relations the statistics never read", () => {
    const unused = windowInclude.filter((name) => !readByStats.includes(name));
    expect(unused, `reportActivityInclude fetches ${unused.join(", ")} for nothing`).toEqual([]);
  });

  it("fetches a relation for every type the history query filters to", () => {
    // The history query reads a baby's whole past with no date bound, so it fetches only the detail
    // tables its type filter admits. Adding a type without its relation would silently drop that
    // type's data from the growth history. Scoped to the query that uses the history include,
    // because `type: { in: [...] }` is not unique in this file.
    const filter = queryUsing("historyActivityInclude").match(/type: \{ in: \[([^\]]+)\]/);
    expect(filter, "could not find the history query's type filter").toBeTruthy();
    const members = [...filter![1].matchAll(/ActivityType\.([a-z][A-Za-z_]*)/g)].map((m) => m[1]);
    expect(members.length).toBeGreaterThan(0);
    // A filtered type whose detail table this report does not read is legitimate, so this is a
    // one-way check: every filtered type that names a real relation must be fetched.
    const needed = members.map(relationForType).filter((name) => relations.includes(name));
    const unfetched = needed.filter((name) => !historyInclude.includes(name));
    expect(
      unfetched,
      `the history query filters to ${unfetched.join(", ")} but historyActivityInclude does not fetch it`
    ).toEqual([]);
  });

  it("keeps the history include a subset of the window include", () => {
    // Both feed the same reader, so history can only ever narrow what the window already fetches.
    const extra = historyInclude.filter((name) => !windowInclude.includes(name));
    expect(extra, `historyActivityInclude fetches ${extra.join(", ")} the window does not`).toEqual([]);
  });

  it("leaves the shared activityInclude untouched for the entry list and feed", () => {
    // The narrowing is local to reports; the full hydration other surfaces need must not be edited
    // here, and reports must not quietly fall back to it.
    expect(reportsSource).not.toMatch(/include: activityInclude/);
  });
});
