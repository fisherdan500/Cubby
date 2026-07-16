export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startAutomatedBackupScheduler } = await import("@/server/automated-backup-scheduler");
    await startAutomatedBackupScheduler();
  }
}
