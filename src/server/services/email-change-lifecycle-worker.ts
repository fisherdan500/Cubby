type LifecycleDatabase = {
  $queryRaw<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
};

export async function runEmailChangeLifecycleWorkerTick(database: LifecycleDatabase, batchLimit = 100) {
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 500) throw new Error("email_change_lifecycle_batch_invalid");
  const rows = await database.$queryRaw<Array<{ expiredChanges: number; expiredRotations: number }>>`
    SELECT expired_changes AS "expiredChanges", expired_rotations AS "expiredRotations"
    FROM "run_email_change_lifecycle_batch"(${batchLimit}::integer)
  `;
  if (rows.length !== 1) throw new Error("email_change_lifecycle_batch_unavailable");
  return rows[0]!;
}
