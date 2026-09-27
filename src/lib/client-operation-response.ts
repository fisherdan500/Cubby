import { z } from "zod";

// Mirrors the content-free wire variants in browser-operations.ts. No server imports.
const operationId = z.string().regex(/^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$/);
export const householdPartitionSchema = z.object({
  version: z.literal(1), scope: z.literal("household"), partition: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("open"), operationId, bindingId: z.string().min(1) }).strict(),
  z.object({ status: z.literal("prepared"), operationId, code: z.literal("operation_prepared") }).strict(),
  z.object({ status: z.literal("pending"), operationId, code: z.literal("operation_unknown").optional() }).strict(),
  z.object({ status: z.literal("completed"), operationId, outcome: z.unknown() }).strict(),
  z.object({ status: z.literal("rejected"), operationId, code: z.enum(["idempotency_conflict", "operation_integrity_error"]) }).strict(),
  z.object({ status: z.literal("stale"), operationId, code: z.enum(["stale_context", "stale_target", "inactive_baby", "stale_revision", "state_conflict"]) }).strict(),
  z.object({ status: z.literal("expired"), operationId, code: z.enum(["operation_result_expired", "operation_abandoned"]) }).strict()
]);
export type OutcomeValidator = (outcome: unknown) => boolean;
export async function clientOperationResponse(response: Response, validOutcome: OutcomeValidator, expectedId?: string) {
  const body = await response.json().catch(() => null) as {
    ok?: boolean; data?: { operationId?: string }; error?: { code?: string; message?: string };
  } | null;
  const envelope = z.object({ ok: z.literal(true), data: resultSchema }).strict().safeParse(body);
  const data = envelope.success ? envelope.data.data : undefined;
  const expectedStatus = data?.status === "expired" ? 410 : data?.status === "prepared" || data?.status === "pending" ? 202 : 200;
  let outcomeMatches = data?.status !== "completed";
  if (data?.status === "completed" && data.outcome && typeof data.outcome === "object" && !Array.isArray(data.outcome)) {
    // Persistence binds the receipt to this operation. Remove only that binding
    // before the operation-specific closed payload check; keep the wire body intact.
    const { operationId: nestedId, ...payload } = data.outcome as Record<string, unknown>;
    outcomeMatches = operationId.safeParse(nestedId).success && nestedId === data.operationId && validOutcome(payload);
  }
  const valid = data && response.status === expectedStatus && (!expectedId || data.operationId === expectedId) && outcomeMatches;
  return { response, body, status: valid ? data.status : undefined };
}

export function feedOutcomeValidator(url: string, method: string, fields: Record<string, unknown>, intentKnowledge: "known" | "unknown" = "known"): OutcomeValidator {
  const target = /^\/api\/feed\/(posts|comments)(?:\/([^/]+)(\/restore)?)?$/.exec(url);
  if (target) {
    const [, family, encodedId, restore] = target;
    const id = encodedId ? decodeURIComponent(encodedId) : undefined;
    const code = !id && method === "POST" ? "created" : id && !restore && method === "PATCH" ? "updated"
      : id && !restore && method === "DELETE" ? "deleted" : id && family === "posts" && restore && method === "POST" ? "restored" : null;
    if (!code) return () => false;
    const schema = z.object({ kind: z.literal(family === "posts" ? "feed_post" : "feed_comment"), code: z.literal(code),
      [family === "posts" ? "postId" : "commentId"]: id ? z.literal(id) : z.string().min(1) }).strict();
    return (outcome) => schema.safeParse(outcome).success;
  }
  if (url === "/api/feed/reactions" && method === "PUT") {
    const schema = z.object({ kind: z.literal("feed_reaction"), code: z.literal("set"),
      reaction: z.enum(["love", "funny", "aww", "celebrate", "well_done"]), on: z.boolean() }).strict();
    return (outcome) => {
      const parsed = schema.safeParse(outcome);
      // An ID-only pointer surviving reload cannot establish the prior on/off
      // intent. Its valid receipt retires the old ID, never the new intent.
      return parsed.success && parsed.data.reaction === fields.reaction && (intentKnowledge === "unknown" || parsed.data.on === fields.on);
    };
  }
  return () => false;
}
