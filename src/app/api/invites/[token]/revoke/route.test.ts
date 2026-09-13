import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("legacy invitation revoke route", () => {
  it("does not inspect a token-bearing route", async () => {
    const response = await POST(new Request("http://localhost/api/invites/secret/revoke", { method: "POST" }), { params: { token: "secret" } });
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    await expect(response.json()).resolves.toEqual({ ok: true, data: { status: "unavailable" } });
  });
});
