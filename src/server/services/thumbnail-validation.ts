import { spawn } from "node:child_process";
import path from "node:path";

/** Internal child boundary; the caller owns shared photo-decode admission. */
export async function validateThumbnailInChild(bytes: Buffer): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [path.join(process.cwd(), "runtime", "thumbnail-validator.cjs")], {
        shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}), NODE_ENV: "production", UV_THREADPOOL_SIZE: "1", VIPS_CONCURRENCY: "1" }
      });
    } catch { resolve(false); return; }
    let failed = false;
    const stop = () => {
      if (failed) return;
      failed = true;
      // A failed signal is not proof of death. Keep admission held until close.
      try { child.kill("SIGKILL"); } catch { /* fail closed, without native diagnostics */ }
    };
    const deadline = setTimeout(stop, 5000);
    let output = "";
    let outputBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return;
      outputBytes += chunk.length;
      if (outputBytes > 64) { stop(); return; }
      output += chunk.toString("utf8");
    });
    // No diagnostic is retained or logged; even one stderr byte invalidates the result.
    child.stderr.on("data", stop);
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.stderr.on("error", stop);
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      resolve(!failed && code === 0 && signal === null && output === "cubby-thumbnail-v1:valid\n");
    });
    try { child.stdin.end(bytes); } catch { stop(); }
  });
}
