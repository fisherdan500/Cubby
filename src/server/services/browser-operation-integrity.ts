import { prisma } from "@/lib/db/prisma";

export async function verifyBrowserOperationInfrastructure() {
  const rows = await prisma.$queryRaw<Array<{
    household_binding_table: boolean;
    household_operation_table: boolean;
    household_tombstone_table: boolean;
    household_reservation_tombstone_table: boolean;
    household_compaction_function: boolean;
    household_binding_insert_guard: boolean;
    household_reservation_insert_guard: boolean;
    household_binding_delete_guard: boolean;
    household_reservation_immutability_guard: boolean;
    household_terminal_outcome_constraint: boolean;
    household_operation_transition_guard: boolean;
    household_mismatch_count: bigint;
    account_binding_table: boolean;
    account_operation_table: boolean;
    account_tombstone_table: boolean;
    account_reservation_tombstone_table: boolean;
    account_compaction_function: boolean;
    account_binding_insert_guard: boolean;
    account_reservation_insert_guard: boolean;
    account_binding_delete_guard: boolean;
    account_reservation_immutability_guard: boolean;
    account_terminal_outcome_constraint: boolean;
    account_operation_transition_guard: boolean;
    account_mismatch_count: bigint;
  }>>`
    SELECT
      to_regclass('"BrowserOperationBinding"') IS NOT NULL AS household_binding_table,
      to_regclass('"BrowserMutationOperation"') IS NOT NULL AS household_operation_table,
      to_regclass('"BrowserMutationOperationTombstone"') IS NOT NULL AS household_tombstone_table,
      to_regclass('"BrowserOperationReservationTombstone"') IS NOT NULL AS household_reservation_tombstone_table,
      to_regprocedure('compact_household_browser_operation(text,text,timestamp without time zone)') IS NOT NULL AS household_compaction_function,
      to_regprocedure('guard_household_browser_operation_binding_insert()') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'BrowserOperationBinding_identity_insert_guard' AND tgrelid = to_regclass('"BrowserOperationBinding"') AND NOT tgisinternal
      ) AS household_binding_insert_guard,
      to_regprocedure('guard_browser_operation_reservation_tombstone_insert()') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'BrowserOperationReservationTombstone_binding_guard' AND tgrelid = to_regclass('"BrowserOperationReservationTombstone"') AND NOT tgisinternal
      ) AS household_reservation_insert_guard,
      to_regprocedure('enforce_browser_operation_binding_write_once()') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'BrowserOperationBinding_write_once' AND tgrelid = to_regclass('"BrowserOperationBinding"') AND NOT tgisinternal
      ) AS household_binding_delete_guard,
      to_regprocedure('prevent_browser_operation_reservation_tombstone_mutation()') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'BrowserOperationReservationTombstone_immutable' AND tgrelid = to_regclass('"BrowserOperationReservationTombstone"') AND NOT tgisinternal
      ) AS household_reservation_immutability_guard,
      EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'BrowserMutationOperation_terminal_outcome_check' AND conrelid = to_regclass('"BrowserMutationOperation"')
      ) AS household_terminal_outcome_constraint,
      to_regprocedure('enforce_browser_mutation_operation_transition()') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'BrowserMutationOperation_enforce_transition' AND tgrelid = to_regclass('"BrowserMutationOperation"') AND NOT tgisinternal
      ) AS household_operation_transition_guard,
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
      to_regclass('"AccountOperationReservationTombstone"') IS NOT NULL AS account_reservation_tombstone_table,
      to_regprocedure('compact_account_browser_operation(text,text,timestamp without time zone)') IS NOT NULL AS account_compaction_function,
      to_regprocedure('guard_account_operation_binding_insert()') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'AccountOperationBinding_identity_insert_guard' AND tgrelid = to_regclass('"AccountOperationBinding"') AND NOT tgisinternal
      ) AS account_binding_insert_guard,
      to_regprocedure('guard_account_operation_reservation_tombstone_insert()') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'AccountOperationReservationTombstone_binding_guard' AND tgrelid = to_regclass('"AccountOperationReservationTombstone"') AND NOT tgisinternal
      ) AS account_reservation_insert_guard,
      to_regprocedure('enforce_account_operation_binding_write_once()') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'AccountOperationBinding_write_once' AND tgrelid = to_regclass('"AccountOperationBinding"') AND NOT tgisinternal
      ) AS account_binding_delete_guard,
      to_regprocedure('prevent_account_operation_reservation_tombstone_mutation()') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'AccountOperationReservationTombstone_immutable' AND tgrelid = to_regclass('"AccountOperationReservationTombstone"') AND NOT tgisinternal
      ) AS account_reservation_immutability_guard,
      EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'AccountMutationOperation_terminal_outcome_check' AND conrelid = to_regclass('"AccountMutationOperation"')
      ) AS account_terminal_outcome_constraint,
      to_regprocedure('enforce_account_mutation_operation_transition()') IS NOT NULL AND EXISTS (
        SELECT 1 FROM pg_trigger WHERE tgname = 'AccountMutationOperation_enforce_transition' AND tgrelid = to_regclass('"AccountMutationOperation"') AND NOT tgisinternal
      ) AS account_operation_transition_guard,
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
      !result.household_tombstone_table || !result.household_reservation_tombstone_table ||
      !result.household_compaction_function || !result.household_binding_insert_guard ||
      !result.household_reservation_insert_guard || !result.household_binding_delete_guard ||
      !result.household_reservation_immutability_guard || !result.household_terminal_outcome_constraint ||
      !result.household_operation_transition_guard ||
      !result.account_binding_table || !result.account_operation_table ||
      !result.account_tombstone_table || !result.account_reservation_tombstone_table ||
      !result.account_compaction_function || !result.account_binding_insert_guard ||
      !result.account_reservation_insert_guard || !result.account_binding_delete_guard ||
      !result.account_reservation_immutability_guard || !result.account_terminal_outcome_constraint ||
      !result.account_operation_transition_guard) {
    throw new Error("browser_operation_integrity_unavailable");
  }
  if (result.household_mismatch_count !== 0n || result.account_mismatch_count !== 0n) {
    throw new Error("browser_operation_integrity_mismatch");
  }
  return { status: "ready" as const };
}
