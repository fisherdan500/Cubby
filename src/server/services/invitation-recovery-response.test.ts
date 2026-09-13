import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("invitation recovery enrollment response", () => {
  it("returns each display-once recovery code beside its opaque server-issued ID for the required rehearsal", () => {
    const source = readFileSync(resolve(process.cwd(), "src/server/services/invitation-route-layer.ts"), "utf8");
    expect(source).toContain("codeEntries");
    expect(source).toContain("codeId: batch.records[index]!.codeId");
    expect(source).toContain("nonce: reservation.nonce.toString(\"base64url\")");
  });
});
