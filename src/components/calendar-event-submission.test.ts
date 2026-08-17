import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./calendar-event-submission.tsx", import.meta.url), "utf8");

describe("CalendarEventSubmission", () => {
  it("retains each immutable intent's browser operation across a remount and intercepts submit inline", () => {
    expect(source).toContain("cubby:calendar-operation:${intentKey}");
    expect(source).toContain("operation.current?.intentKey === intentKey");
    expect(source).toContain("retainOperationId(intentKey, operationId)");
    expect(source).toContain("clearRetainedOperationId(intentKey)");
    expect(source).toContain("<form onSubmit={submit}");
    expect(source).toContain("event.preventDefault()");
    expect(source).not.toContain("<form action={submit}");
  });

  it("reconciles a retained operation after response loss before reissuing or replaying it", () => {
    expect(source).toContain("/api/browser-operations/${operationId}");
    expect(source).toContain("response.status === 410");
    expect(source).toContain("status === \"pending\"");
    expect(source).toContain("status === \"completed\"");
    expect(source).toContain("status === \"stale\"");
  });
});
