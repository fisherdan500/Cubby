import { describe, expect, it } from "vitest";
import { handleError } from "./http";

describe("handleError", () => {
  it("returns a safe conflict response for a stale mutation revision", async () => {
    const response = handleError(new Error("stale_revision"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "stale_revision",
        message: "This item changed before your request completed. Refresh and try again."
      }
    });
  });
});
