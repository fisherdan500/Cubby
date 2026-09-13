import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("operation-registry checker stack safety", () => {
  it("walks static member assignment source files iteratively", () => {
    const checker = readFileSync(resolve(process.cwd(), "src/server/operation-registry/checker.ts"), "utf8");
    const start = checker.indexOf("function resolveStaticMemberValue");
    const end = checker.indexOf("function staticMemberAssignmentTarget", start);
    const implementation = checker.slice(start, end);

    expect(implementation).toContain("const pendingNodes: ts.Node[] = [];");
    expect(implementation).toContain("while (pendingNodes.length > 0)");
    expect(implementation).not.toContain("ts.forEachChild(node, visit);");
  });
});
