import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = new URL("../", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "generated" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("display-time contract", () => {
  it("never formats dates with the process or device zone", () => {
    // toLocaleString and friends use the server process zone during rendering and the device zone in the
    // browser, so one time could render two ways. Use formatInstant / formatInstantDate /
    // formatCalendarDate from @/lib/timezone with the household zone instead.
    const offenders = sourceFiles(sourceRoot)
      .filter((file) => /\.toLocale(?:Date|Time)?String\(/.test(readFileSync(file, "utf8")))
      .map((file) => relative(sourceRoot, file).replaceAll("\\", "/"));
    expect(offenders).toEqual([]);
  });
});
