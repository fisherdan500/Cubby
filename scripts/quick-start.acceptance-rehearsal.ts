import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Disposable acceptance gate for the documented fresh-server path: a clean copy of the checkout, the
// quick start run as root in a stock Debian container (the supported target, with nothing but its base
// tools), then `docker compose up --build` on empty volumes. It proves what a new operator depends on:
// the stack starts from the generated .env alone, the setup code reaches the log, the first account
// can be created and used to sign in, the container can write its data directories and read its key,
// and no generated secret ever appears in the log.
//
// Nothing here touches the normal runtime: its own copy, Compose project, port, volumes and image,
// all removed afterwards. It needs a Linux Docker host, where bind mounts keep real ownership.

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const excluded = new Set([".git", "node_modules", ".next", "dist", "coverage", "docker-data", ".env"]);

function run(command: string, args: string[], cwd: string, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (result.error || result.status !== 0) throw new Error(`quick_start_acceptance_failed: ${command} ${args.slice(0, 4).join(" ")}`);
  return String(result.stdout ?? "");
}

async function freePort() {
  return new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : rejectPort(new Error("quick_start_port_unavailable"))));
    });
  });
}

/** The generated secrets only; addresses, paths and the time zone may legitimately appear in a log. */
function secretValues(checkout: string) {
  return readFileSync(resolve(checkout, ".env"), "utf8")
    .split("\n")
    .map((line) => /^([A-Z0-9_]+)=(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match) && /(SECRET|PASSWORD|_KEY|KEYRING)$/.test(match![1]!))
    .flatMap((match) => match[2]!.trim().replace(/^'(.*)'$/, "$1").split(/[:,]/).filter((part) => part.length >= 16));
}

export async function runQuickStartAcceptanceRehearsal() {
  if (process.platform !== "linux" || typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("quick_start_acceptance_requires_linux");
  }
  const checkout = resolve(mkdtempSync(resolve(tmpdir(), "cubby-quick-start-acceptance-")), "cubby");
  cpSync(root, checkout, { recursive: true, filter: (source) => !excluded.has(basename(source)) });
  const project = `cubby_quick_start_${randomBytes(4).toString("hex")}`;
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const compose = ["compose", "--project-name", project];
  let composeStarted = false;
  try {
    // A mail server the stack is configured for but never reaches: nothing is sent during the rehearsal,
    // and the email worker's startup check only validates the configuration.
    writeFileSync(resolve(checkout, "smtp-password"), `${randomBytes(18).toString("hex")}\n`, { mode: 0o600 });
    // As `sudo sh scripts/quick-start.sh` would, from the operator's account.
    run("docker", [
      "run", "--rm", "--volume", `${checkout}:/cubby`, "--workdir", "/cubby",
      "--env", `SUDO_UID=${process.getuid()}`, "--env", `SUDO_GID=${process.getgid()}`,
      "debian:bookworm-slim", "sh", "scripts/quick-start.sh", "--url", origin, "--port", String(port),
      "--smtp-host", "smtp.quick-start.invalid", "--smtp-user", "cubby@quick-start.invalid",
      "--email-from", "Cubby <cubby@quick-start.invalid>", "--smtp-password-file", "smtp-password"
    ], checkout);

    composeStarted = true;
    try {
      run("docker", [...compose, "up", "--build", "--detach", "--wait"], checkout);
    } catch (error) {
      // The app's own account of why it never became healthy, captured before teardown removes it.
      // The entrypoint writes no secret to the log, which the check at the end of a passing run proves.
      const appLog = spawnSync("docker", [...compose, "logs", "--no-color", "--tail", "80", "app"], { cwd: checkout, encoding: "utf8" });
      console.error(`--- app log (last 80 lines) ---\n${appLog.stdout ?? ""}${appLog.stderr ?? ""}--- end app log ---`);
      throw error;
    }

    const health = await fetch(`${origin}/api/health`, { cache: "no-store" });
    if (!health.ok) throw new Error(`quick_start_health_invalid:${health.status}`);

    const startupLog = run("docker", [...compose, "logs", "--no-color", "app"], checkout, true);
    if (!startupLog.includes("Cubby has no platform owner yet")) throw new Error("quick_start_setup_code_missing");
    // Each start issues a new code and retires the last, so only the most recent one is live.
    const code = [...startupLog.matchAll(/\b(?:[0-9A-HJKMNP-TV-Z]{4}-){3}[0-9A-HJKMNP-TV-Z]{4}\b/g)].at(-1)?.[0];
    if (!code) throw new Error("quick_start_setup_code_unreadable");

    const setupPage = await fetch(`${origin}/setup`, { cache: "no-store", redirect: "manual" });
    if (setupPage.status !== 200 || !(await setupPage.text()).includes("Create account and become owner")) {
      throw new Error(`quick_start_setup_page_invalid:${setupPage.status}`);
    }

    const password = randomBytes(18).toString("base64url");
    const email = "owner@quick-start.invalid";
    const created = await fetch(`${origin}/api/platform/setup/account`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ code, name: "Quick Start Owner", email, password })
    });
    const createdBody = (await created.json().catch(() => null)) as { ok?: boolean; data?: { ownerUserId?: string } } | null;
    if (!created.ok || !createdBody?.ok || !createdBody.data?.ownerUserId) {
      throw new Error(`quick_start_first_account_failed:${created.status}:${JSON.stringify(createdBody)}`);
    }

    const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password, rememberMe: false })
    });
    if (!signIn.ok || !/better-auth\.session_token=/.test(signIn.headers.get("set-cookie") ?? "")) {
      throw new Error(`quick_start_sign_in_failed:${signIn.status}`);
    }

    run("docker", [...compose, "exec", "-T", "app", "sh", "-c", [
      "set -e",
      "for dir in /var/lib/cubby/backups /var/lib/cubby/sprout-staging; do probe=\"$dir/.quick-start-probe-$$\"; : > \"$probe\"; rm \"$probe\"; done",
      "test -r /run/secrets/cubby_sprout_staging_key"
    ].join("; ")], checkout);

    const fullLog = run("docker", [...compose, "logs", "--no-color"], checkout, true);
    for (const secret of [...secretValues(checkout), password]) {
      if (fullLog.includes(secret)) throw new Error("quick_start_secret_in_log");
    }
    process.stdout.write("QUICK_START_ACCEPTANCE_PASS\n");
  } finally {
    if (composeStarted) {
      spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans", "--rmi", "local"], { cwd: checkout, stdio: "ignore" });
    }
    // The data directories now belong to the container's user, so they are removed the way they were made.
    spawnSync("docker", ["run", "--rm", "--volume", `${resolve(checkout, "..")}:/work`, "debian:bookworm-slim", "rm", "-rf", "/work/cubby"], { stdio: "ignore" });
    rmSync(resolve(checkout, ".."), { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void runQuickStartAcceptanceRehearsal().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
