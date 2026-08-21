export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [
      { startAutomatedBackupScheduler },
      { startIntegrityScheduler },
      { startSproutSourceRetentionScheduler },
      { startBrowserOperationRetentionScheduler }
    ] = await Promise.all([
      import("@/server/automated-backup-scheduler"),
      import("@/server/integrity-scheduler"),
      import("@/server/sprout-source-retention-scheduler"),
      import("@/server/browser-operation-retention-scheduler")
    ]);
    await Promise.all([
      startAutomatedBackupScheduler(),
      startIntegrityScheduler(),
      startSproutSourceRetentionScheduler(),
      startBrowserOperationRetentionScheduler()
    ]);
  }
}
