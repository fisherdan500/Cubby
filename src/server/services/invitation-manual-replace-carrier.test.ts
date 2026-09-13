import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("manual invitation replacement carrier", () => {
  it("binds replacement to the selected pending invitation through the reviewed target carrier", () => {
    const route = readFileSync(resolve(process.cwd(), "src/server/services/invitation-route-layer.ts"), "utf8");
    const service = readFileSync(resolve(process.cwd(), "src/server/services/invitation-service.ts"), "utf8");
    expect(route).toContain("inviteId: text(input, \"inviteId\")");
    expect(service).toContain("target: input.inviteId ?? null");
  });
});
