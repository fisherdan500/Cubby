import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ queryRaw: vi.fn() }));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { $queryRaw: mocks.queryRaw }
}));

import { dynamic, GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => {
    mocks.queryRaw.mockReset();
  });

  it("returns the bounded ready response after the database probe succeeds", async () => {
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);

    const response = await GET();

    expect(mocks.queryRaw).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
  });

  it("returns a sanitized unavailable response when the database probe fails", async () => {
    const secret = "postgresql://user:password@private-db:5432/cubby";
    mocks.queryRaw.mockRejectedValue(
      Object.assign(new Error(`connection failed for ${secret}`), {
        stack: `Error: ${secret}\n at private-db.internal`
      })
    );

    const response = await GET();
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({ status: "unavailable" });
    expect(body).not.toContain(secret);
    expect(body).not.toContain("private-db");
    expect(body).not.toContain("connection failed");
    expect(body).not.toContain("stack");
  });

  it("is dynamic and prohibits caching for every readiness response", async () => {
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const ready = await GET();

    mocks.queryRaw.mockRejectedValue(new Error("database unavailable"));
    const unavailable = await GET();

    expect(dynamic).toBe("force-dynamic");
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
  });
});
