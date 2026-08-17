import { prisma } from "@/lib/db/prisma";

export async function verifyBrowserOperationInfrastructure() {
  const rows = await prisma.$queryRaw<Array<{
    household_binding_table: boolean;
    household_operation_table: boolean;
    household_tombstone_table: boolean;
    household_compaction_function: boolean;
    household_mismatch_count: bigint;
    account_binding_table: boolean;
    account_operation_table: boolean;
    account_tombstone_table: boolean;
    account_compaction_function: boolean;
    account_mismatch_count: bigint;
  }>>`
    SELECT
      to_regclass('"BrowserOperationBinding"') IS NOT NULL AS household_binding_table,
      to_regclass('"BrowserMutationOperation"') IS NOT NULL AS household_operation_table,
      to_regclass('"BrowserMutationOperationTombstone"') IS NOT NULL AS household_tombstone_table,
      to_regprocedure('compact_household_browser_operation(text,text,timestamp without time zone)') IS NOT NULL AS household_compaction_function,
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
      ) AS household_mismatch_count,
      to_regclass('"AccountOperationBinding"') IS NOT NULL AS account_binding_table,
      to_regclass('"AccountMutationOperation"') IS NOT NULL AS account_operation_table,
      to_regclass('"AccountMutationOperationTombstone"') IS NOT NULL AS account_tombstone_table,
      to_regprocedure('compact_account_browser_operation(text,text,timestamp without time zone)') IS NOT NULL AS account_compaction_function,
      (
        SELECT COUNT(*)
        FROM "AccountMutationOperation" operation
        LEFT JOIN "AccountOperationBinding" binding ON binding."id" = operation."bindingId"
        WHERE operation."persistenceVersion" = 2
          AND (
            binding."id" IS NULL
            OR binding."userId" IS DISTINCT FROM operation."userId"
            OR binding."operationId" IS DISTINCT FROM operation."operationId"
            OR binding."operationKey" IS DISTINCT FROM operation."operationKey"
            OR binding."openingFingerprint" IS DISTINCT FROM operation."openingFingerprint"
          )
      ) AS account_mismatch_count
  `;
  const result = rows[0];
  if (!result ||
      !result.household_binding_table || !result.household_operation_table ||
      !result.household_tombstone_table || !result.household_compaction_function ||
      !result.account_binding_table || !result.account_operation_table ||
      !result.account_tombstone_table || !result.account_compaction_function) {
    throw new Error("browser_operation_integrity_unavailable");
  }
  if (result.household_mismatch_count !== 0n || result.account_mismatch_count !== 0n) {
    throw new Error("browser_operation_integrity_mismatch");
  }
  return { status: "ready" as const };
}
