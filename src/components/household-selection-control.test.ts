import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  HouseholdSelectionControl,
  type HouseholdSelectionState
} from "@/components/household-selection-control";

const options = [
  { memberId: "member-1", householdId: "household-1", householdName: "River House", role: "owner" as const },
  { memberId: "member-2", householdId: "household-2", householdName: "Maple House", role: "parent" as const }
];

function render(state: HouseholdSelectionState) {
  return renderToStaticMarkup(React.createElement(HouseholdSelectionControl, { state }));
}

describe("HouseholdSelectionControl", () => {
  it("persistently names the server-authorized household and offers an explicit labelled selector", () => {
    const html = render({ status: "selected", selected: options[1], options });

    expect(html).toContain("Current household");
    expect(html).toContain("Maple House");
    expect(html).toContain("Choose household");
    expect(html).toContain('name="returnTo"');
    expect(html).toContain('value="/app"');
    expect(html).toContain('name="memberId"');
    expect(html).toContain('value="member-2" selected=""');
    expect(html).toContain("min-h-11");
  });

  it.each([
    ["missing", "Select a household to continue."],
    ["stale", "Your previous household selection is no longer available."]
  ] as const)("renders an accessible %s selection-required state", (status, message) => {
    const html = render({ status, selected: null, options });

    expect(html).toContain(message);
    expect(html).toContain("Choose household");
    expect(html).toContain("Continue");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("min-h-11");
  });
});
