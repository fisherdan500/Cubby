import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The account profile page is a server component that needs a session, so these read the source the
 * way the repository's other page tests do: the point is that the control is REACHABLE and that the
 * entry in Settings names what the page now holds.
 */
const page = readFileSync("src/app/account/profile/page.tsx", "utf8");
const settings = readFileSync("src/app/app/settings/page.tsx", "utf8");

describe("your own account page", () => {
  it("offers the name control, not only the picture", () => {
    expect(page).toContain("ProfileNameControl");
    expect(page).toContain("ProfilePhotoControl");
  });

  it("hands the control the name the session already resolved", () => {
    expect(page).toMatch(/<ProfileNameControl name=\{user\.name\}/);
  });

  it("stays outside member.manage, so a caretaker can still correct their own name", () => {
    // The members screen is gated on member.manage. If this page ever moved behind that gate, the
    // roles that most need to fix their own name would be the ones who could not.
    expect(page).toContain("requireUserPage");
    expect(page).not.toContain("member.manage");
    expect(page).not.toContain("requirePermission");
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
