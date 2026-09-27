import { readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import type { BrowserOperationRetentionResult } from "../src/server/services/browser-operation-retention";

// Execute only the actual fixture callback with injected inert dependencies. Never import the
// integration module: its beforeAll and real Prisma constructors require separate DB authority.
const source = ts.createSourceFile("fixture.ts", readFileSync(new URL("./browser-operation-pilot.dec-prod-407.acceptance.integration.test.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const cases = [
  "retries concurrent account submits across Serializable User contention",
  "serializes real abandon, retention, and status work behind identity locks"
];
function callback(title: string, dependencies: Record<string, unknown>): () => Promise<void> {
  let body: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "it" &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === title) body = node.arguments[1];
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!body) throw new Error("fixture_callback_missing");
  const compiled = ts.transpileModule(`const fixture = ${body.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${compiled}\nreturn fixture;`)(...Object.values(dependencies));
}

describe("retention fixture identity isolation", () => {
  it.each([1, 4])("asserts its own rows after retention also deletes %i rows from failed prior fixtures", async (leftovers) => {
    const household = new Map<string, Record<string, unknown>>();
    const account = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < leftovers; index++) household.set(`failed-fixture-${index}`, { persistenceVersion: 2 });
    const model = (rows: Map<string, Record<string, unknown>>) => ({
      create: vi.fn(async ({ data }: { data: Record<string, unknown> & { id: string } }) => {
        rows.set(data.id, { openingFingerprint: null, state: "open", ...data });
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null)
    });
    const householdModel = model(household);
    const accountModel = model(account);
    const run = callback("writes scope-owned expiry tombstones before real retention deletes expired reservations", {
      auth: {}, fingerprint: "a".repeat(64), expect,
      prisma: {
        browserOperationBinding: householdModel, accountOperationBinding: accountModel,
        browserOperationReservationTombstone: { count: vi.fn().mockResolvedValue(1) },
        accountOperationReservationTombstone: { count: vi.fn().mockResolvedValue(1) }
      },
      runBrowserOperationRetention: async (): Promise<BrowserOperationRetentionResult> => {
        let deletedBindingCount = 0;
        for (const [id, row] of household) if (row.persistenceVersion === 2) { household.delete(id); deletedBindingCount++; }
        account.delete("dec-ab-retention");
        return {
          household: { unresolvedAlertCount: 0, compactedCount: 0, deletedBindingCount },
          account: { unresolvedAlertCount: 0, compactedCount: 0, deletedBindingCount: 1 }
        };
      },
      getHouseholdBrowserOperationStatus: async (operationId: string) => ({ status: "expired", operationId, code: "operation_result_expired" }),
      getAccountBrowserOperationStatus: async (operationId: string) => ({ status: "expired", operationId, code: "operation_result_expired" })
    });
    await expect(run()).resolves.toBeUndefined();
    expect(householdModel.findUnique).toHaveBeenCalledWith({ where: { id: "dec-hb-retention" } });
    expect(accountModel.findUnique).toHaveBeenCalledWith({ where: { id: "dec-ab-retention" } });
  });
});

for (const title of cases) {
  describe(title, () => {
    it.each(["waiter", "setup", "worker", "cleanup"])("releases, settles and disconnects after %s failure", async (mode) => {
      const failure = new Error(`synthetic_${mode}_failure`);
      const cleanupFailure = new Error("synthetic_disconnect_failure");
      const order: string[] = [];
      let settled!: () => void;
      const barrierSettled = new Promise<void>((resolve) => { settled = resolve; });
      const observer = {
        $transaction: vi.fn((run: (tx: object) => Promise<void>) => {
          const promise = (mode === "setup" ? Promise.reject(failure) : Promise.resolve().then(() => run({
            $queryRaw: vi.fn().mockResolvedValue([]), $executeRaw: vi.fn().mockResolvedValue(0)
          }))).finally(() => { order.push("barrier_settled"); settled(); });
          // Observe the injected promise too, so a broken fixture's unhandled rejection does not
          // obscure the deterministic readiness/cleanup assertion below.
          void promise.catch(() => undefined);
          return promise;
        }),
        $disconnect: vi.fn(async () => { order.push("disconnected"); if (mode === "cleanup") throw cleanupFailure; })
      };
      const worker = vi.fn(async () => {
        await barrierSettled;
        order.push("worker_settled");
        if (mode === "worker") throw failure;
        return {};
      });
      const run = callback(title, {
        process: { env: {} },
        PrismaClient: function () { return observer; },
        auth: { session: {}, context: {} },
        prisma: { browserOperationBinding: { createMany: vi.fn().mockResolvedValue({ count: 2 }) } },
        issueAccountAppearanceBrowserOperation: vi.fn().mockResolvedValue({ operationId: "synthetic_operation" }),
        submitAccountAppearanceBrowserOperation: worker,
        abandonHouseholdBrowserOperation: worker,
        runBrowserOperationRetention: worker,
        getHouseholdBrowserOperationStatus: worker,
        waitForLockWaiters: vi.fn(async () => { if (mode === "waiter" || mode === "cleanup") throw failure; }),
        fingerprint: "a".repeat(64),
        expect
      });
      const result = run().then(() => "unexpected_success", (error: unknown) => error);
      const outcome = await Promise.race([result, nextTurn().then(() => "fixture_did_not_settle")]);
      if (mode === "cleanup") {
        expect(outcome).toBeInstanceOf(AggregateError);
        expect((outcome as AggregateError).errors).toEqual([failure, cleanupFailure]);
      } else expect(outcome).toBe(failure);
      expect(observer.$disconnect).toHaveBeenCalledOnce();
      expect(order[order.length - 1]).toBe("disconnected");
      expect(order).toContain("barrier_settled");
      if (mode !== "setup") expect(order.filter((entry) => entry === "worker_settled")).toHaveLength(title === cases[0] ? 2 : 3);
    });
  });
}
