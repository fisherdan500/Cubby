import { describe, expect, it } from "vitest";
import { createProgramFromSources, discoverClientBindings } from "@/server/operation-registry/checker";

/**
 * Two halves of the same regression.
 *
 * resolveStaticMemberValue collected child nodes with `ts.forEachChild(node, (c) => pending.push(c))`.
 * push returns the new length, forEachChild stops at the first truthy visitor result, so the scan
 * stopped after a file's first child and never saw the assignment it was looking for. It failed
 * closed, so the checker under-approximated rather than mis-approving - but the engine had never
 * actually traversed a whole file.
 *
 * Restoring the traversal exposed what the bug had been hiding: the mutually recursive static-flow
 * family has cycle guards but no depth bound, so long non-cyclic chains in real source exhausted the
 * call stack (~30 cases of the checker's own fast subset died with RangeError). The family now
 * reports `ambiguous` past staticRootFlowDepthLimit, which surfaces as the same
 * unsupported_client_binding the checker already emits for a chain it cannot follow.
 */
const repositoryRoot = process.cwd();
const aliasChain = (length: number) =>
  Array.from({ length }, (_, index) => (index === 0 ? "const hop0 = fetch;" : `const hop${index} = hop${index - 1};`)).join(" ");

describe("static-flow resolver depth", () => {
  it("walks past a file's first statement to resolve a property assignment", () => {
    const owner = "src/features/property-fetch.tsx";
    const program = createProgramFromSources(repositoryRoot, {
      [owner]: '"use client"; const transport: any = {}; transport.request = globalThis.fetch; transport.request("/api/request");'
    });

    const result = discoverClientBindings(program, repositoryRoot, [owner]);

    expect(result.observations.map(({ kind, target }) => ({ kind, target }))).toEqual([
      { kind: "global_fetch", target: "globalThis.fetch" }
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("resolves an alias chain far longer than any real one", () => {
    const owner = "src/features/shallow-chain.tsx";
    const program = createProgramFromSources(repositoryRoot, {
      [owner]: `"use client"; ${aliasChain(40)} hop39("/api/shallow");`
    });

    const result = discoverClientBindings(program, repositoryRoot, [owner]);

    expect(result.observations.map(({ kind }) => kind)).toEqual(["global_fetch"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("fails closed on a fan-out that would otherwise never finish", () => {
    // Each level is written twice, so the value is `unsupported` and every candidate is resolved
    // independently with its own copy of the `seen` set: 2^n paths. Without the work budget this
    // does not overflow, it simply runs forever - which is how it stalled the checker's own suite.
    const owner = "src/features/fan-out-chain.tsx";
    const fanOut = Array.from({ length: 16 }, (_, index) =>
      index === 0
        ? "let step0: any = fetch; step0 = globalThis.fetch;"
        : `let step${index}: any = step${index - 1}; step${index} = step${index - 1};`
    ).join(" ");
    const program = createProgramFromSources(repositoryRoot, {
      [owner]: `"use client"; ${fanOut} step15("/api/fan-out");`
    });

    const result = discoverClientBindings(program, repositoryRoot, [owner]);

    // A diagnostic, promptly - not a hang, and not a wrong approval.
    expect(result.observations).toEqual([]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["unsupported_client_binding"]);
  }, 30_000);
});
