// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { ProfileNameControl, saveOwnName } from "@/components/members/profile-name-control";

describe("saving your own name", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends the name to the route that only touches your own account", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, data: { name: "Daniel Fisher" } })
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveOwnName("Daniel Fisher")).resolves.toEqual({ ok: true, name: "Daniel Fisher" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/members/me/name");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ name: "Daniel Fisher" });
  });

  it("shows the server's own words when it refuses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, error: { message: "That name is too long." } })
    }));

    await expect(saveOwnName("x".repeat(200))).resolves.toEqual({
      ok: false,
      message: "That name is too long."
    });
  });

  it("says the connection failed rather than claiming the name was saved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    const result = await saveOwnName("Daniel Fisher");

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("message", "Could not reach Cubby. Check your connection and try again.");
  });

  it("does not trust a success that carries no name", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, data: {} }) }));

    expect((await saveOwnName("Daniel Fisher")).ok).toBe(false);
  });
});

describe("the name control", () => {
  it("offers a labelled field holding the current name", () => {
    const markup = renderToStaticMarkup(<ProfileNameControl name="Dan Fisher" />);

    expect(markup).toContain('id="own-name"');
    expect(markup).toContain('value="Dan Fisher"');
    expect(markup).toContain("Your name");
  });

  it("caps the field at the length the account can hold", () => {
    const markup = renderToStaticMarkup(<ProfileNameControl name="Dan Fisher" />);

    expect(markup).toContain('maxLength="80"');
  });

  it("will not submit a name that has not changed", () => {
    const markup = renderToStaticMarkup(<ProfileNameControl name="Dan Fisher" />);
    const button = markup.slice(markup.indexOf("<button"), markup.indexOf("</button>"));

    // Disabled on the SAVE BUTTON specifically: a loose search for the word would pass even if the
    // attribute landed on the field instead, which would stop the name being typed at all.
    expect(button).toContain("disabled");
    expect(markup.slice(markup.indexOf("<input"), markup.indexOf(">", markup.indexOf("<input")))).not.toContain("disabled");
  });

  it("requires the field rather than letting an empty name be submitted", () => {
    const markup = renderToStaticMarkup(<ProfileNameControl name="Dan Fisher" />);
    const field = markup.slice(markup.indexOf("<input"), markup.indexOf(">", markup.indexOf("<input")));

    expect(field).toContain("required");
  });
});
