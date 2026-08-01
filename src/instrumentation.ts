export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [{ startAutomatedBackupScheduler }, { startIntegrityScheduler }, { startSproutSourceRetentionScheduler }] = await Promise.all([
      import("@/server/automated-backup-scheduler"),
      import("@/server/integrity-scheduler"),
      import("@/server/sprout-source-retention-scheduler")
    ]);
    await Promise.all([startAutomatedBackupScheduler(), startIntegrityScheduler(), startSproutSourceRetentionScheduler()]);
  }
}
