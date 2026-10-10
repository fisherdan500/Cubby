import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const unknownFailure = "FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_UNKNOWN\n";
const STARTUP_TIMEOUT_MS = 30_000;
const FORCE_KILL_GRACE_MS = 2_000;

function lifecycleOutputs(browserCodes) {
  const failures = ["FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_CLEANUP_FAILED\n"];
  for (const phase of ["PREFLIGHT_EXPORT", "DOCKER_IMAGE_START", "FIXTURE", "ACTION_DISCOVERY", "BROWSER_LAUNCH", "BROWSER_OBSERVATION", "TERMINAL", "UNKNOWN"]) {
    const prefix = `FRESHNESS_ACCEPTANCE_FAILED\nFRESHNESS_PHASE_${phase}\n`;
    for (const suffix of phase === "BROWSER_OBSERVATION" ? browserCodes.map(code => `FRESHNESS_BROWSER_${code.toUpperCase()}\n`) : [""]) {
      failures.push(prefix + suffix, prefix + suffix + "FRESHNESS_CLEANUP_FAILED\n");
    }
  }
  return failures;
}

async function launch() {
  let child, candidate = "", failed = false, interrupted = false, ready = false, closed = false;
  let startupTimer, forceKillTimer;
  let terminateUnready = () => {};
  const onSignal = () => {
    interrupted = true;
    if (!ready) {
      terminateUnready();
      return;
    }
    if (!child?.connected) return;
    try { child.send("FRESHNESS_INTERRUPT", error => { if (error) { candidate = ""; failed = true; } }); }
    catch { candidate = ""; failed = true; }
  };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
  try {
    const { FRESHNESS_BROWSER_FAILURE_CODES } = await import("./cross-device-freshness-browser-contract.mjs");
    const failures = lifecycleOutputs(FRESHNESS_BROWSER_FAILURE_CODES);
    const args = process.argv.slice(2);
    const success = args.length === 0 ? "FRESHNESS_ACCEPTANCE_PASS\nFRESHNESS_CLEANUP_PASS\n"
      : args.length === 2 && args[0] === "--recover" && args[1] ? "FRESHNESS_CLEANUP_PASS\n" : undefined;
    const limit = Math.max(success?.length ?? 0, ...failures.map(marker => marker.length));
    child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./cross-device-freshness.acceptance-rehearsal.ts", import.meta.url)), ...args], {
      stdio: ["ignore", "pipe", "ignore", "ipc"], windowsHide: true
    });
    child.stdout.on("data", chunk => {
      if (failed) return;
      if (candidate.length + chunk.length > limit) { candidate = ""; failed = true; return; }
      candidate += chunk.toString("utf8");
    });
    child.stdout.once("error", () => { candidate = ""; failed = true; });
    child.once("error", () => { candidate = ""; failed = true; });
    let terminatedBeforeReady = false;
    child.on("message", message => {
      if (message !== "FRESHNESS_READY" || ready || terminatedBeforeReady) return;
      ready = true;
      clearTimeout(startupTimer);
    });
    const completion = new Promise(done => child.once("close", (code, signal) => {
        closed = true;
        clearTimeout(startupTimer);
        clearTimeout(forceKillTimer);
        const output = !failed && !signal && Number.isInteger(code) && code >= 0 && code <= 255
          ? (code === 0 ? (!interrupted && candidate === success ? success : undefined) : failures.find(marker => marker === candidate))
          : undefined;
        candidate = "";
        process.stdout.write(output ?? unknownFailure);
        process.exitCode = output !== undefined && output === success ? 0 : 1;
        done();
      }));
    terminateUnready = () => {
      if (ready || terminatedBeforeReady || closed) return;
      terminatedBeforeReady = true;
      interrupted = true;
      failed = true;
      candidate = "";
      try { child.kill("SIGTERM"); } catch { /* the forced attempt remains authoritative */ }
      if (!closed) {
        forceKillTimer = setTimeout(() => {
          if (closed) return;
          try { child.kill("SIGKILL"); } catch { /* close remains the completion boundary */ }
        }, FORCE_KILL_GRACE_MS);
      }
    };
    startupTimer = setTimeout(terminateUnready, STARTUP_TIMEOUT_MS);
    if (interrupted) terminateUnready();
    await completion;
  } finally {
    candidate = "";
    clearTimeout(startupTimer); clearTimeout(forceKillTimer);
    process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal);
  }
}

launch().catch(() => { process.stdout.write(unknownFailure); process.exitCode = 1; });
