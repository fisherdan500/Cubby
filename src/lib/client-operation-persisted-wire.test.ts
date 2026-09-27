import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextResponse } from "next/server";
import ts from "typescript";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { clientOperationResponse, feedOutcomeValidator, type OutcomeValidator } from "./client-operation-response";

// Evaluate only named source declarations: importing the service would bootstrap DB/auth.
function declarations(path: string, names: string[]) {
  const source = ts.createSourceFile(path, readFileSync(resolve(path), "utf8"), ts.ScriptTarget.Latest, true);
  return names.map((name) => {
    const node = source.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === name);
    if (!node) throw new Error(`source_function_missing:${name}`);
    return node.getText(source).replace(/^export\s+/, "");
  }).join("\n");
}
function compile(source: string) {
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
type Result = { status: string; operationId: string; outcome: Record<string, unknown> };
type Row = { operationId: string; status: string; outcomeCode: string; outcomeSnapshot: Record<string, unknown> };
type Adapter = {
  browserMutationOperation: { update: (args: { data: Omit<Row, "operationId"> }) => Promise<Row> };
  browserOperationBinding: { update: () => Promise<object> };
};
const { persist, read } = new Function("BrowserMutationOperationStatus", "Prisma", compile(declarations(
  "src/server/services/browser-operations.ts", ["browserOperationResultFromPersistence", "persistTerminalOperation"]
)) + "\nreturn { persist: persistTerminalOperation, read: browserOperationResultFromPersistence };")(
  { completed: "completed", stale: "stale", rejected: "rejected" }, { DbNull: null }
) as { persist: (db: Adapter, binding: { id: string; householdId: string; operationId: string }, result: Result) => Promise<Result>; read: (row: Row) => Result };
const ok = new Function("NextResponse", compile(declarations("src/server/http.ts", ["ok"])) + "\nreturn ok;")(NextResponse) as (data: unknown) => Response;
const planValidator = new Function("z", compile(declarations("src/components/reports/planned-schedule.tsx", ["planOutcomeValidator"])) + "\nreturn planOutcomeValidator;")(z) as (babyId: string, revision: number, itemCount: number) => OutcomeValidator;
const id = "bmo_0123456789abcdefghjkmnpqrs";
const otherId = "bmo_zzzzzzzzzzzzzzzzzzzzzzzzzz";
const variants = [
  ["/api/feed/posts", "POST", { kind: "feed_post", code: "created", postId: "p" }],
  ["/api/feed/posts/p", "PATCH", { kind: "feed_post", code: "updated", postId: "p" }],
  ["/api/feed/posts/p", "DELETE", { kind: "feed_post", code: "deleted", postId: "p" }],
  ["/api/feed/posts/p/restore", "POST", { kind: "feed_post", code: "restored", postId: "p" }],
  ["/api/feed/comments", "POST", { kind: "feed_comment", code: "created", commentId: "c" }],
  ["/api/feed/comments/c", "PATCH", { kind: "feed_comment", code: "updated", commentId: "c" }],
  ["/api/feed/comments/c", "DELETE", { kind: "feed_comment", code: "deleted", commentId: "c" }],
  ["/api/feed/reactions", "PUT", { kind: "feed_reaction", code: "set", reaction: "love", on: true }],
  ["/api/babies/baby/schedule", "PUT", { kind: "planned_schedule", code: "ok", babyId: "baby", revision: 3, itemCount: 1 }]
] as const;

async function persisted(outcome: Record<string, unknown>, via: string) {
  let stored!: Row;
  const db: Adapter = {
    browserMutationOperation: { update: async ({ data }) => {
      stored = JSON.parse(JSON.stringify({ operationId: id, ...data })) as Row;
      return stored;
    } },
    browserOperationBinding: { update: vi.fn(async () => ({})) }
  };
  const direct = await persist(db, { id: "binding", householdId: "household", operationId: id }, { status: "completed", operationId: id, outcome });
  expect(db.browserOperationBinding.update).toHaveBeenCalledOnce();
  // Status lookup uses the same persistence reader on the retained row, not the callback.
  return via === "direct" ? direct : read(JSON.parse(JSON.stringify(stored)) as Row);
}

describe.each(["direct", "status"])("persisted %s wire", (via) => {
  it.each(variants)("accepts %s %s without changing the receipt", async (url, method, outcome) => {
    const result = await persisted(outcome, via);
    expect(result.outcome).toEqual({ operationId: id, ...outcome });
    const validate = vi.fn(url.endsWith("/schedule") ? planValidator("baby", 2, 1) : feedOutcomeValidator(url, method, outcome));
    const decoded = await clientOperationResponse(ok(result), validate, id);
    expect(decoded.status).toBe("completed");
    expect(validate).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledWith(outcome);
    expect(decoded.body).toEqual({ ok: true, data: result });
  });

  it.each(variants)("rejects unbound, malformed and open-ended %s %s receipts", async (url, method, outcome) => {
    const result = await persisted(outcome, via);
    const validate = url.endsWith("/schedule") ? planValidator("baby", 2, 1) : feedOutcomeValidator(url, method, outcome);
    const wrongTargets = "postId" in outcome && url !== "/api/feed/posts" ? [{ ...result.outcome, postId: "other" }]
      : "commentId" in outcome && url !== "/api/feed/comments" ? [{ ...result.outcome, commentId: "other" }]
      : "babyId" in outcome ? [{ ...result.outcome, babyId: "other" }, { ...result.outcome, revision: 4 }, { ...result.outcome, itemCount: 2 }]
      : "reaction" in outcome ? [{ ...result.outcome, reaction: "funny" }, { ...result.outcome, on: false }] : [];
    const invalid = [outcome, null, [], ...[otherId, "bmo_short", "", 123, null].map((operationId) => ({ ...result.outcome, operationId })),
      { ...result.outcome, extra: true }, { ...result.outcome, code: "wrong" }, { ...result.outcome, kind: "wrong" }, ...wrongTargets];
    for (const bad of invalid) {
      expect((await clientOperationResponse(ok({ ...result, outcome: bad }), validate, id)).status, JSON.stringify(bad)).toBeUndefined();
    }
    expect((await clientOperationResponse(ok({ ...result, operationId: otherId }), validate, id)).status).toBeUndefined();
    expect((await clientOperationResponse(ok(result), validate, otherId)).status).toBeUndefined();
    expect((await clientOperationResponse(ok({ ...result, operationId: otherId }), validate)).status).toBeUndefined();
    expect((await clientOperationResponse(ok({ ...result, extra: true }), validate, id)).status).toBeUndefined();
  });
});
