import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { NextResponse } from "next/server";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function compiledDeclarations(path: string, names: string[], dependencies: Record<string, unknown>) {
  const source = ts.createSourceFile(path, readFileSync(resolve(path), "utf8"), ts.ScriptTarget.Latest, true);
  const declarations = names.map(name => {
    const node = source.statements.find(candidate => (ts.isFunctionDeclaration(candidate) && candidate.name?.text === name) || (ts.isVariableStatement(candidate) && candidate.declarationList.declarations.some(declaration => declaration.name.getText(source) === name)));
    if (!node) throw new Error("source_declaration_absent");
    return node.getText(source).replace(/^export\s+/, "");
  }).join("\n");
  const compiled = ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return runInNewContext(`${compiled}\n({${names.join(",")}})`, { exports: {}, NextResponse, ...dependencies });
}

const routePath = "src/server/services/invitation-route-layer.ts";
const clientPath = "src/components/invitations/invitation-workflow.tsx";
const serverNames = ["invitationResponseHeaders", "p13RecoveryRouteOriginHeader", "p13RecoveryRouteOriginEnabled", "response", "p13RecoverySubmitRouteOrigin", "recoveryEnrollmentDisplayOnceReceipt"];
const header = "X-Cubby-P13-Recovery-Origin";

describe("compiled recovery-submit transport and receipt boundaries", () => {
  it.each([[undefined, undefined], ["1", undefined], [undefined, "1"], ["0", "1"], ["1", "1"]])("requires both exact server sentinels", (observer, sentinel) => {
    const route = compiledDeclarations(routePath, serverNames, { process: { env: { CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER: observer, CUBBY_P13_ACCEPTANCE_HEALTH_SENTINEL: sentinel } } });
    const response = route.response(null, 200, "submit_terminal_generated");
    expect((response.headers.get(header) !== null) === (observer === "1" && sentinel === "1")).toBe(true);
  });

  it("preserves every closed server receipt category through native NextResponse and compiled client reduction", () => {
    const route = compiledDeclarations(routePath, serverNames, { process: { env: { CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER: "1", CUBBY_P13_ACCEPTANCE_HEALTH_SENTINEL: "1" } } });
    const client = compiledDeclarations(clientPath, ["p13RecoverySubmitRouteOrigin"], {});
    for (const receipt of [null, { status: "unavailable" }, { status: "generated" }, { status: "completed" }, { status: "fresh_auth_bound" }, { status: "prepared" }, { status: "source_other" }, {}]) {
      const expected = route.p13RecoverySubmitRouteOrigin(receipt);
      const response = route.response(null, 200, expected);
      expect(client.p13RecoverySubmitRouteOrigin(response.headers.get(header)) === expected).toBe(true);
    }
  });

  it("never emits to a client binding when the compiled public observer is disabled", () => {
    for (const enabled of [undefined, "0", "1"]) {
      let count = 0;
      const client = compiledDeclarations(clientPath, ["p13RecoverySchemaObserverEnabled", "p13RecoverySubmitRouteOrigin", "emitP13RecoverySubmitRouteOrigin"], {
        process: { env: { NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER: enabled } },
        __cubbyP13RecoveryOriginObserver: () => { count++; }
      });
      client.emitP13RecoverySubmitRouteOrigin("submit_terminal_generated");
      expect(count === (enabled === "1" ? 1 : 0)).toBe(true);
    }
  });

  it("attaches only the matching initial receipt and never rediscloses on replay", () => {
    const { recoveryEnrollmentDisplayOnceReceipt: attach } = compiledDeclarations(routePath, ["recoveryEnrollmentDisplayOnceReceipt"], {});
    const batch = { codes: Array.from({ length: 10 }, () => "source_fixture"), records: Array.from({ length: 10 }, () => ({ codeId: "source_fixture" })) };
    const receipt = { operationId: "source_operation", status: "generated", displayOnce: true };
    expect(attach("source_operation", receipt, batch).codeEntries.length === 10).toBe(true);
    expect("codeEntries" in attach("other_source_operation", receipt, batch)).toBe(false);
    expect("codeEntries" in attach("source_operation", { ...receipt, displayOnce: false }, batch)).toBe(false);
    expect("codeEntries" in attach("source_operation", { ...receipt, status: "completed" }, batch)).toBe(false);
  });
});
