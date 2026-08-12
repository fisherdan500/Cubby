import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./baby-lifecycle-button.tsx", import.meta.url), "utf8");

describe("BabyLifecycleButton", () => {
  it("retains a canonical browser operation ID through transport failures and remounts", () => {
    expect(source).toContain("const operation = useRef<RetainedLifecycleOperation>();");
    expect(source).toContain("body: JSON.stringify({ operationId: next.operationId })");
    expect(source).toContain("return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join(\"\")}`;");
    expect(source).toContain("window.sessionStorage.getItem(lifecycleOperationStorageKey(babyId))");
    expect(source).toContain("window.sessionStorage.setItem(lifecycleOperationStorageKey(babyId), JSON.stringify(next))");
    expect(source).toContain("window.sessionStorage.removeItem(lifecycleOperationStorageKey(babyId))");
    expect(source).toContain("const action = retained?.action ?? (inactive ? \"reactivate\" : \"deactivate\");");
    expect(source).toContain("/api/babies/${babyId}/${action}");

    const transportFailure = source.slice(source.indexOf("} catch {"), source.indexOf("} finally {"));
    expect(transportFailure).not.toContain("operationId.current = undefined");
  });
});
