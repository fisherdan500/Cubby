import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The account profile page is a server component needing a session, so these read the source the
 * way the repository's other page tests do. The point is reachability and authorization SHAPE: that
 * the control is on the page, and that the write path behind it authorizes through a helper which
 * gates the assisted first-login obligation.
 */
const page = readFileSync("src/app/account/profile/page.tsx", "utf8");
const service = readFileSync("src/server/services/own-profile.ts", "utf8");
const settings = readFileSync("src/app/app/settings/page.tsx", "utf8");

describe("your own account page", () => {
  it("offers the name control, not only the picture", () => {
    expect(page).toContain("ProfileNameControl");
    expect(page).toContain("ProfilePhotoControl");
  });

  it("hands the control the name the session already resolved", () => {
    expect(page).toMatch(/<ProfileNameControl name=\{user\.name\}/);
  });

  it("resolves the viewer through the page helper that redirects a corralled identity", () => {
    expect(page).toContain("requireUserPage");
  });
});

describe("the write path's authorization", () => {
  it("authorizes through requireUser, which gates the outstanding-password-change obligation", () => {
    // Asserted positively rather than by the absence of a permission call: `getSession` is
    // deliberately ungated so the password-change corridor can authorize itself, so a service that
    // writes must use a helper that gates. This is the invariant, not a proxy for it.
    expect(service).toContain('import { requireUser } from "@/server/auth/session"');
    expect(service).toContain("await requireUser()");
    // Comments may discuss getSession - the point is that no CODE calls it.
    const code = service.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//")).join("\n");
    expect(code).not.toContain("getSession");
  });
});

describe("the way Settings describes it", () => {
  it("no longer offers only a picture, now that the name lives there too", () => {
    const entry = settings.slice(settings.indexOf('href: "/account/profile"'));
    const label = entry.slice(0, entry.indexOf("}"));

    expect(label).toContain("name");
    expect(label).not.toMatch(/label: "Your picture"/);
  });
});
