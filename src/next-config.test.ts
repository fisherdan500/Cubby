import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.mjs";

describe("next.config redirects", () => {
  it("forwards the old feed address to Moments, so saved links and home-screen shortcuts keep working", async () => {
    const redirects = await nextConfig.redirects?.();

    // Temporary rather than permanent: browsers remember a permanent one for good, and /app/feed may
    // one day be wanted for feeding itself. Next keeps the query string (babyId, filter, tag) as it is.
    expect(redirects).toEqual(expect.arrayContaining([
      { source: "/app/feed", destination: "/app/moments", permanent: false },
      { source: "/app/feed/:path*", destination: "/app/moments/:path*", permanent: false }
    ]));
  });
});
