import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const formSource = new URL("./personal-appearance-form.tsx", import.meta.url);
const pageSource = new URL("../app/account/appearance/page.tsx", import.meta.url);
const rootLayoutSource = new URL("../app/layout.tsx", import.meta.url);

describe("personal appearance UI contract", () => {
  it("uses a durable account operation with remount reconciliation and applies only the returned mode", () => {
    const source = readFileSync(formSource, "utf8");
    expect(source).toContain('/api/account/appearance/issue');
    expect(source).toContain('/api/account/appearance');
    expect(source).toContain('/api/account/browser-operations/');
    expect(source).toContain("sessionStorage");
    expect(source).toContain("setTheme");
    for (const mode of ["system", "light", "dark"]) expect(source).toContain(`value: "${mode}"`);
  });

  it("is reachable without household selection and forces authenticated server preference at first paint", () => {
    const page = readFileSync(pageSource, "utf8");
    const layout = readFileSync(rootLayoutSource, "utf8");
    expect(page).toContain("requireUserPage");
    expect(page).not.toContain("getEffectiveHouseholdContext");
    expect(layout).toContain("getCurrentAuthenticatedAppearanceMode");
    expect(layout).toContain("forcedTheme={appearanceMode}");
  });
});
