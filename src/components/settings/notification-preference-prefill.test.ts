import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Saving a notification preference REPLACES the whole document: the form posts every field from
 * whatever is ticked at that moment (notification-preference-form.tsx submit), so a control that
 * renders blank does not mean "leave this as it was" - it means "turn this off".
 *
 * That made the page a trap. Someone turned on external delivery, saved, came back to a blank form,
 * ticked Moments, saved again - and the second save silently cleared external delivery. Nothing on
 * the page showed it had happened, because the page only ever reported a revision number.
 *
 * These are source contracts rather than rendered-DOM tests because the form is a client component
 * whose state lives in uncontrolled inputs; what matters is that every control is bound to the
 * saved value, and that is exactly what the source can be held to.
 */

const form = readFileSync(
  new URL("./notification-preference-form.tsx", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

const page = readFileSync(
  new URL("../../app/app/settings/notifications/page.tsx", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

describe("the preference form shows what is already saved", () => {
  it("binds every control to the saved document", () => {
    // One per control. A control missing from this list renders blank and is therefore cleared by
    // the next save of any other setting.
    expect(form, "external delivery must show its saved value").toContain("defaultChecked={deliveryChecked}");
    expect(form, "each category checkbox must show whether it is chosen").toContain(
      "defaultChecked={saved?.categories.includes(value) ?? false}"
    );
    expect(form, "the browser push channel must show its saved value").toContain(
      'defaultChecked={saved?.channels.includes("browser_push") ?? false}'
    );
    expect(form, "baby scope must show which mode is saved").toContain('defaultChecked={scope === "all"}');
    expect(form, "baby scope must show which mode is saved").toContain('defaultChecked={scope === "selected"}');
    expect(form, "the selected babies must show their saved values").toContain(
      "defaultValue={saved?.selectedBabyIds ?? []}"
    );
    expect(form, "quiet hours must show their saved values").toContain('defaultValue={saved?.quietHoursStart ?? ""}');
    expect(form, "quiet hours must show their saved values").toContain('defaultValue={saved?.quietHoursEnd ?? ""}');
    expect(form, "interruption level must show its saved value").toContain(
      'defaultValue={saved?.interruptionLevel ?? "normal"}'
    );
  });

  it("leaves no control unbound", () => {
    // A bare checkbox or a hardcoded default is the exact shape of the original defect, so this
    // catches a new control added later without binding it.
    const bareCheckbox = form.match(/<input\s+name=[^>]*type="checkbox"(?![^>]*defaultChecked)[^>]*\/>/g) ?? [];
    expect(bareCheckbox, `unbound checkbox: ${bareCheckbox.join(" | ")}`).toEqual([]);
    expect(form, "a hardcoded defaultChecked ignores what is saved").not.toMatch(/defaultChecked\s*\/>/);
    expect(form, "a hardcoded interruption level ignores what is saved").not.toContain('defaultValue="normal"');
  });

  it("still forces external delivery to be re-affirmed after a restore", () => {
    // needs_review exists so that a restored preference cannot keep sending until a person confirms
    // it. Pre-filling must not quietly undo that.
    expect(form).toContain('state === "needs_review" ? false : Boolean(saved?.externalDeliveryEnabled)');
  });

  it("accepts the saved document from the page", () => {
    expect(form).toContain("saved?: SavedPreference | null");
    expect(page, "the page must pass what is saved, or the form renders blank").toContain("saved={saved}");
  });
});

describe("the page says what will actually be sent", () => {
  it("reports the real settings rather than a revision number", () => {
    expect(page).toContain("What you will be sent");
    expect(page, "a revision number tells a person nothing about what they will receive").not.toContain(
      "Revision {preference.document.revision}"
    );
  });

  it("names the switch that is stopping delivery", () => {
    // Push needs external delivery AND a category AND the channel. Each looks fine alone, so the
    // page has to say which one is missing - that is what cost the household a working setup.
    expect(page).toContain('saved.externalDeliveryEnabled ? null : "external delivery"');
    expect(page).toContain('saved.categories.length > 0 ? null : "at least one category"');
    expect(page).toContain('saved.channels.includes("browser_push") ? null : "the browser push channel"');
    expect(page).toContain("Nothing will be sent yet");
  });

  it("shows chosen categories by their labels, not their stored values", () => {
    expect(page).toContain("CATEGORY_LABELS");
    expect(page).toContain('moments: "Moments"');
  });
});
