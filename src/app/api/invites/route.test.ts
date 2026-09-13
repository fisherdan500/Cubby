import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/invites/route";

describe("legacy invite creation route", () => {
  it("is a no-store neutral denial", async () => {
    const response = await POST(new Request("http://localhost/api/invites", { method: "POST" }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true, data: { status: "unavailable" } });
  });
});
