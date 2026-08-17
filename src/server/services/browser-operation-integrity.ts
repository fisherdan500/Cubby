import { prisma } from "@/lib/db/prisma";

export async function verifyBrowserOperationInfrastructure() {
  const rows = await prisma.$queryRaw<Array<{
    binding_table: boolean;
    operation_table: boolean;
    tombstone_table: boolean;
    compaction_function: boolean;
    mismatch_count: bigint;
  }>>`
    SELECT
      to_regclass('"BrowserOperationBinding"') IS NOT NULL AS binding_table,
      to_regclass('"BrowserMutationOperation"') IS NOT NULL AS operation_table,
      to_regclass('"BrowserMutationOperationTombstone"') IS NOT NULL AS tombstone_table,
      to_regprocedure('compact_household_browser_operation(text,text,timestamp without time zone)') IS NOT NULL AS compaction_function,
      (
        SELECT COUNT(*)
        FROM "BrowserMutationOperation" operation
        LEFT JOIN "BrowserOperationBinding" binding ON binding."id" = operation."bindingId"
        WHERE operation."persistenceVersion" = 2
          AND (
            binding."id" IS NULL
            OR binding."householdId" IS DISTINCT FROM operation."householdId"
            OR binding."operationId" IS DISTINCT FROM operation."operationId"
            OR binding."operationKey" IS DISTINCT FROM operation."operationKey"
            OR binding."actorUserId" IS DISTINCT FROM operation."actorUserId"
            OR binding."actorMemberId" IS DISTINCT FROM operation."actorMemberId"
            OR binding."openingFingerprint" IS DISTINCT FROM operation."openingFingerprint"
            OR binding."targetKind" IS DISTINCT FROM operation."targetKind"
            OR binding."targetId" IS DISTINCT FROM operation."targetId"
            OR binding."babyId" IS DISTINCT FROM operation."babyId"
          )
      ) AS mismatch_count
  `;
  const result = rows[0];
  if (!result?.binding_table || !result.operation_table || !result.tombstone_table || !result.compaction_function) {
    throw new Error("browser_operation_integrity_unavailable");
  }
  if (result.mismatch_count !== 0n) throw new Error("browser_operation_integrity_mismatch");
  return { status: "ready" as const };
}
