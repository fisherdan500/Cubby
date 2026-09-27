import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { BrowserOperationKey } from "@prisma/client";
import { expect, it } from "vitest";
import { clientOperationResponse, feedOutcomeValidator, householdPartitionSchema } from "./client-operation-response";

// Execute only the actual server's literal schema declaration, never its imports/services.
const source = ts.createSourceFile("browser-operations.ts", readFileSync(resolve("src/server/services/browser-operations.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations])
  .find((node) => node.name.getText(source) === "terminalOutcomeSchemas");
if (!declaration?.initializer) throw new Error("producer_schemas_not_found");
const producer = new Function("z", "BrowserOperationKey", `return (${declaration.initializer.getText(source)});`)(z, BrowserOperationKey) as Record<string, z.ZodTypeAny>;
const id = "bmo_0123456789abcdefghjkmnpqrs";
const variants = [
  [BrowserOperationKey.feedPostCreate, "/api/feed/posts", "POST", { kind: "feed_post", code: "created", postId: "p" }],
  [BrowserOperationKey.feedPostUpdate, "/api/feed/posts/p", "PATCH", { kind: "feed_post", code: "updated", postId: "p" }],
  [BrowserOperationKey.feedPostDelete, "/api/feed/posts/p", "DELETE", { kind: "feed_post", code: "deleted", postId: "p" }],
  [BrowserOperationKey.feedPostRestore, "/api/feed/posts/p/restore", "POST", { kind: "feed_post", code: "restored", postId: "p" }],
  [BrowserOperationKey.feedCommentCreate, "/api/feed/comments", "POST", { kind: "feed_comment", code: "created", commentId: "c" }],
  [BrowserOperationKey.feedCommentUpdate, "/api/feed/comments/c", "PATCH", { kind: "feed_comment", code: "updated", commentId: "c" }],
  [BrowserOperationKey.feedCommentDelete, "/api/feed/comments/c", "DELETE", { kind: "feed_comment", code: "deleted", commentId: "c" }],
  [BrowserOperationKey.feedReactionSet, "/api/feed/reactions", "PUT", { kind: "feed_reaction", code: "set", reaction: "well_done", on: false }]
] as const;
it.each(variants)("agrees with actual producer schema for %s", (key, url, method, valid) => {
  const validate = feedOutcomeValidator(url, method, valid);
  const mutations = [valid, {}, { ...valid, kind: "other" }, { ...valid, code: "wrong" }, { ...valid, extra: true },
    ...Object.keys(valid).map((field) => Object.fromEntries(Object.entries(valid).filter(([name]) => field !== name)))];
  for (const value of mutations) expect(validate(value)).toBe(producer[key].safeParse(value).success);
});
it("rejects malformed household partition variants", () => {
  const valid = { version: 1, scope: "household", partition: "a".repeat(64) };
  expect(householdPartitionSchema.safeParse(valid).success).toBe(true);
  for (const value of [{ ...valid, version: 2 }, { ...valid, scope: "account" }, { ...valid, partition: "household-a" }, { ...valid, partition: "A".repeat(64) }, { ...valid, extra: true }]) {
    expect(householdPartitionSchema.safeParse(value).success).toBe(false);
  }
});
const wireVariants: Array<[unknown, number, string]> = [
  [{ status: "open", operationId: id, bindingId: "binding" }, 200, "open"],
  [{ status: "prepared", operationId: id, code: "operation_prepared" }, 202, "prepared"],
  [{ status: "pending", operationId: id }, 202, "pending"],
  ...["idempotency_conflict", "operation_integrity_error"].map<[unknown, number, string]>((code) => [{ status: "rejected", operationId: id, code }, 200, "rejected"]),
  ...["stale_context", "stale_target", "inactive_baby", "stale_revision", "state_conflict"].map<[unknown, number, string]>((code) => [{ status: "stale", operationId: id, code }, 200, "stale"]),
  ...["operation_abandoned", "operation_result_expired"].map<[unknown, number, string]>((code) => [{ status: "expired", operationId: id, code }, 410, "expired"])
];
it.each(wireVariants)("accepts only exact wire identity/envelope for %j", async (data, status, expected) => {
  const decode = (value: unknown, http = Number(status), expectedId = id) => clientOperationResponse(new Response(JSON.stringify(value), { status: http }), () => false, expectedId);
  expect((await decode({ ok: true, data })).status).toBe(expected);
  expect((await decode({ ok: true, data }, 503)).status).toBeUndefined();
  expect((await decode({ ok: true, data }, Number(status), "bmo_zzzzzzzzzzzzzzzzzzzzzzzzzz")).status).toBeUndefined();
  expect((await decode({ ok: 1, data })).status).toBeUndefined();
  expect((await decode({ ok: true, data, error: {} })).status).toBeUndefined();
});
it.each(["", "bmo_short", 123, null])("never accepts malformed issuance identity %j", async (operationId) => {
  const decoded = await clientOperationResponse(new Response(JSON.stringify({ ok: true, data: { status: "open", operationId, bindingId: "binding" } })), () => false);
  expect(decoded.status).toBeUndefined();
});
