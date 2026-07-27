export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [{ startAutomatedBackupScheduler }, { startIntegrityScheduler }] = await Promise.all([
      import("@/server/automated-backup-scheduler"),
      import("@/server/integrity-scheduler")
    ]);
    await Promise.all([startAutomatedBackupScheduler(), startIntegrityScheduler()]);
  }
}
