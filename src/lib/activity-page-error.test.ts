import { describe, expect, it } from "vitest";
import { activityUnavailableOrThrow } from "@/lib/activity-page-error";

describe("activityUnavailableOrThrow", () => {
  it.each(["not_found", "forbidden"])("maps expected %s errors to an unavailable activity", (message) => {
    expect(activityUnavailableOrThrow(new Error(message))).toBeNull();
  });

  it("rethrows unexpected service failures", () => {
    const error = new Error("database unavailable");

    expect(() => activityUnavailableOrThrow(error)).toThrow(error);
  });
});