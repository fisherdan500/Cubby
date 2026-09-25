import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Disposable acceptance gate for losing a whole server and bringing it back from one archive
// (docs/recovery/system-backup.md). On a fresh quick-start install it creates the platform owner's
// account, a household, a Moments post and a stored photo, then runs scripts/system-backup.sh and
// copies the archive "off the server". It then destroys the database volume and the photos, as a
// dead disk would, and restores with scripts/system-restore.sh using the kept .env. It proves the
// owner signs in with their original password, the household, post and photo are back with the
// photo's exact bytes, and that a second restore onto the now-populated install is refused.
//
// Nothing here touches the normal runtime: its own copy, Compose project, port, volumes and image,
// all removed afterwards. It needs a Linux Docker host, where bind mounts keep real ownership.

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const excluded = new Set([".git", "node_modules", ".next", "dist", "coverage", "docker-data", ".env"]);

type Run = { cwd: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; capture?: boolean; allowFailure?: boolean };

function run(command: string, args: string[], { cwd, env, input, capture = false, allowFailure = false }: Run) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"]
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`system_backup_acceptance_failed: ${command} ${args.slice(0, 5).join(" ")}\n${result.stderr ?? ""}`);
  }
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

async function freePort() {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : rejectPort(new Error("system_backup_port_unavailable"))));
    });
  });
}

export async function runSystemBackupAcceptanceRehearsal() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("system_backup_acceptance_requires_linux");
  }
  const workspace = mkdtempSync(resolve(tmpdir(), "cubby-system-backup-acceptance-"));
  const checkout = resolve(workspace, "cubby");
  const offsite = resolve(workspace, "offsite");
  mkdirSync(offsite);
  cpSync(root, checkout, { recursive: true, filter: (source) => !excluded.has(basename(source)) });
  const project = `cubby_system_backup_${randomBytes(4).toString("hex")}`;
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const compose = ["compose", "--project-name", project];
  // The scripts call plain `docker compose`, as an operator would; this keeps them on the rehearsal's project.
  const scriptEnv = { ...process.env, COMPOSE_PROJECT_NAME: project };
  const sql = (statement: string) =>
    run("docker", [...compose, "exec", "-T", "postgres", "psql", "-U", "cubby_migrator", "-d", "cubby", "-XAt", "-v", "ON_ERROR_STOP=1"], {
      cwd: checkout, input: statement, capture: true
    }).stdout.trim();
  let composeStarted = false;
  try {
    writeFileSync(resolve(checkout, "smtp-password"), `${randomBytes(18).toString("hex")}\n`, { mode: 0o600 });
    run("docker", [
      "run", "--rm", "--volume", `${checkout}:/cubby`, "--workdir", "/cubby",
      "--env", `SUDO_UID=${process.getuid()}`, "--env", `SUDO_GID=${process.getgid()}`,
      "debian:bookworm-slim", "sh", "scripts/quick-start.sh", "--url", origin, "--port", String(port),
      "--smtp-host", "smtp.system-backup.invalid", "--smtp-user", "cubby@system-backup.invalid",
      "--email-from", "Cubby <cubby@system-backup.invalid>", "--smtp-password-file", "smtp-password"
    ], { cwd: checkout });

    composeStarted = true;
    run("docker", [...compose, "up", "--build", "--detach", "--wait"], { cwd: checkout });

    // The platform owner's account, created the way a new operator creates it.
    const startupLog = run("docker", [...compose, "logs", "--no-color", "app"], { cwd: checkout, capture: true }).stdout;
    const code = [...startupLog.matchAll(/\b(?:[0-9A-HJKMNP-TV-Z]{4}-){3}[0-9A-HJKMNP-TV-Z]{4}\b/g)].at(-1)?.[0];
    if (!code) throw new Error("system_backup_setup_code_unreadable");
    const email = "owner@system-backup.invalid";
    const password = randomBytes(18).toString("base64url");
    const created = await fetch(`${origin}/api/platform/setup/account`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ code, name: "Rehearsal Owner", email, password })
    });
    const createdBody = (await created.json().catch(() => null)) as { ok?: boolean; data?: { ownerUserId?: string } } | null;
    const ownerUserId = createdBody?.data?.ownerUserId;
    if (!created.ok || !ownerUserId || !/^[A-Za-z0-9_-]+$/.test(ownerUserId)) throw new Error(`system_backup_first_account_failed:${created.status}`);

    // A household with a Moments post and a stored photo, written straight to the database and store.
    const storageKey = randomBytes(16).toString("hex");
    const photo = randomBytes(4096);
    const digest = createHash("sha256").update(photo).digest("hex");
    sql(`
      INSERT INTO "Household" ("id", "name", "createdByUserId", "updatedAt") VALUES ('rehearsalhousehold0000001', 'Rehearsal Home', '${ownerUserId}', now());
      INSERT INTO "FeedPost" ("id", "householdId", "body", "updatedAt") VALUES ('rehearsalpost000000000001', 'rehearsalhousehold0000001', 'First bath', now());
      INSERT INTO "Attachment" ("id", "householdId", "type", "state", "storageKey", "byteSize", "sha256", "mimeType", "width", "height", "postId", "position", "activatedAt", "updatedAt")
        VALUES ('rehearsalphoto00000000001', 'rehearsalhousehold0000001', 'feed_photo', 'available', '${storageKey}', ${photo.length}, '${digest}', 'image/jpeg', 640, 480, 'rehearsalpost000000000001', 0, now(), now());
    `);
    const photoPath = `/var/lib/cubby/attachments/objects/${storageKey.slice(0, 2)}/${storageKey}`;
    run("docker", [...compose, "exec", "-T", "app", "sh", "-c", `mkdir -p "$(dirname '${photoPath}')" && cat > '${photoPath}'`], { cwd: checkout, input: photo });

    // The backup, then a copy of it off the server.
    const backup = run("sh", ["scripts/system-backup.sh"], { cwd: checkout, env: scriptEnv, capture: true });
    if (!/system_backup_created .* households=1 accounts=1 photos=1/.test(backup.stdout)) throw new Error(`system_backup_summary_unexpected:${backup.stdout}`);
    const archives = readdirSync(resolve(checkout, "docker-data", "system-backups")).filter((name) => /^cubby-system-\d{8}T\d{6}Z\.tar$/.test(name));
    if (archives.length !== 1) throw new Error("system_backup_archive_missing");
    const kept = resolve(offsite, archives[0]!);
    copyFileSync(resolve(checkout, "docker-data", "system-backups", archives[0]!), kept);

    // The disk dies: the database volume and every photo are gone. The .env was kept separately.
    run("docker", [...compose, "exec", "-T", "app", "sh", "-c", "rm -rf /var/lib/cubby/attachments/objects"], { cwd: checkout });
    run("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: checkout });

    const restore = run("sh", ["scripts/system-restore.sh", "--archive", kept, "--confirm-empty-install"], { cwd: checkout, env: scriptEnv, capture: true });
    if (!/system_restore_complete households=1 accounts=1 photos=1/.test(restore.stdout)) {
      throw new Error(`system_restore_summary_unexpected:${restore.stdout}\n${restore.stderr}`);
    }

    const health = await fetch(`${origin}/api/health`, { cache: "no-store" });
    if (!health.ok) throw new Error(`system_backup_health_invalid:${health.status}`);
    const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password, rememberMe: false })
    });
    if (!signIn.ok || !/better-auth\.session_token=/.test(signIn.headers.get("set-cookie") ?? "")) {
      throw new Error(`system_backup_restored_sign_in_failed:${signIn.status}`);
    }
    const restored = sql(`SELECT h."name" || '|' || p."body" || '|' || a."state" FROM "Household" h JOIN "FeedPost" p ON p."householdId" = h."id" JOIN "Attachment" a ON a."postId" = p."id" WHERE h."id" = 'rehearsalhousehold0000001'`);
    if (restored !== "Rehearsal Home|First bath|available") throw new Error(`system_backup_restored_rows_unexpected:${restored}`);
    const restoredDigest = run("docker", [...compose, "exec", "-T", "app", "sha256sum", photoPath], { cwd: checkout, capture: true }).stdout.split(/\s+/)[0];
    if (restoredDigest !== digest) throw new Error("system_backup_restored_photo_differs");
    const owner = run("docker", [...compose, "exec", "-T", "app", "stat", "-c", "%u", photoPath], { cwd: checkout, capture: true }).stdout.trim();
    if (owner === "0") throw new Error("system_backup_restored_photo_owned_by_root");

    // The install is no longer empty, so a second restore must refuse before changing anything.
    const again = run("sh", ["scripts/system-restore.sh", "--archive", kept, "--confirm-empty-install"], { cwd: checkout, env: scriptEnv, capture: true, allowFailure: true });
    if (again.status === 0 || !again.stderr.includes("restore only into a new, empty install")) throw new Error("system_backup_second_restore_not_refused");

    process.stdout.write("SYSTEM_BACKUP_ACCEPTANCE_PASS\n");
  } catch (error) {
    if (composeStarted) {
      const appLog = spawnSync("docker", [...compose, "logs", "--no-color", "--tail", "80", "app"], { cwd: checkout, encoding: "utf8" });
      console.error(`--- app log (last 80 lines) ---\n${appLog.stdout ?? ""}${appLog.stderr ?? ""}--- end app log ---`);
    }
    throw error;
  } finally {
    if (composeStarted) {
      spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans", "--rmi", "local"], { cwd: checkout, stdio: "ignore" });
    }
    // The data directories belong to the container's user, so they are removed the way they were made.
    spawnSync("docker", ["run", "--rm", "--volume", `${workspace}:/work`, "debian:bookworm-slim", "rm", "-rf", "/work/cubby", "/work/offsite"], { stdio: "ignore" });
    rmSync(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runSystemBackupAcceptanceRehearsal().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
