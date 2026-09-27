import { z } from "zod";
import { HISTORY_PAGE_SIZE } from "@/lib/history-pagination";

const boundarySchema = z.object({
  at: z.string().datetime(), kind: z.enum(["post", "activity"]), id: z.string().min(1).max(200)
}).strict();
export type MomentsBoundary = z.infer<typeof boundarySchema>;
export const MOMENTS_QUERY = { take: HISTORY_PAGE_SIZE + 1, orderBy: [{ occurredAt: "desc" as const }, { id: "desc" as const }] };

export function momentsCursor(boundary: MomentsBoundary) {
  return `m1.${Buffer.from(JSON.stringify(boundary)).toString("base64url")}`;
}

/** Legacy ID-only and invalid cursors restart at newest, never relax visibility filters. */
export function parseMomentsCursor(cursor?: string): MomentsBoundary | undefined {
  if (!cursor || cursor.length > 1024 || !/^m1\.[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  try {
    const parsed = boundarySchema.safeParse(JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** Total order: occurredAt DESC, posts before activities, then each source's id DESC. */
export function momentsAfter(kind: MomentsBoundary["kind"], boundary: MomentsBoundary) {
  const at = new Date(boundary.at);
  if (kind !== boundary.kind) return { occurredAt: kind === "activity" ? { lte: at } : { lt: at } };
  return { OR: [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: boundary.id } }] };
}
