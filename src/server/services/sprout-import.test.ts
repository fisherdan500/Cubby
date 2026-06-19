import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { sproutImportTestUtils } from "@/server/services/sprout-import";

describe("sprout import parsing", () => {
  it("reads Sprout data.json and env metadata from a backup zip", async () => {
    const zip = new JSZip();
    zip.file(
      "data.json",
      JSON.stringify({
        data: {
          Baby: [{ id: "baby-1", firstName: "Finley", birthDate: "2026-03-13T00:00:00.000Z" }],
          FeedLog: [{ id: "feed-1", babyId: "baby-1", time: "2026-06-19T10:00:00.000Z", type: "BOTTLE" }]
        }
      })
    );
    zip.file("2026-06-19.backup.env", "ENC_HASH=\"abc123\"\nDATABASE_URL=\"file:/db/baby-tracker.db\"");

    const bytes = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
    const parsed = await sproutImportTestUtils.parseSproutBackup(bytes, "sprout-track-backup.zip");

    expect(parsed.format).toBe("json");
    expect(parsed.env.present).toBe(true);
    expect(parsed.env.encHashPresent).toBe(true);
    expect(parsed.tables.Baby).toHaveLength(1);
    expect(parsed.tables.FeedLog).toHaveLength(1);
  });

  it("rejects non-SQLite standalone database uploads", () => {
    expect(() => sproutImportTestUtils.validateSqlite(Buffer.from("not a sqlite database"))).toThrow(
      "invalid_sqlite_backup"
    );
  });

  it("coerces Sprout warning times and measurement rows", () => {
    expect(sproutImportTestUtils.parseWarningMinutes("02:15")).toBe(135);
    expect(sproutImportTestUtils.parseWarningMinutes("90")).toBe(90);
    expect(
      sproutImportTestUtils.mapMeasurement({
        type: "HEAD_CIRCUMFERENCE",
        value: 14.25,
        unit: "IN"
      })
    ).toEqual({ headCircumference: 14.25, headUnit: "in", measurementType: "head" });
  });
});
