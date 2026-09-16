import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const dockerfile = read("Dockerfile");
const dockerignore = read(".dockerignore");
const packageJson = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };

/** Returns one Dockerfile stage body, from its FROM ... AS <stage> line to the next FROM. */
function stage(name: string) {
  const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}\\r?$`, "m"));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const rest = dockerfile.slice(start);
  const next = rest.search(/\r?\nFROM /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("image build caching", () => {
  it("caches npm downloads and Next's incremental build output across rebuilds", () => {
    expect(stage("deps")).toContain("RUN --mount=type=cache,target=/root/.npm npm ci");
    expect(stage("builder")).toContain("RUN --mount=type=cache,target=/app/.next/cache npm run build");
    // Only recomputable caches may be mounted, so a cold builder still produces the same image.
    expect([...dockerfile.matchAll(/--mount=type=cache,target=([^\s,]+)/g)].map((match) => match[1]).sort()).toEqual([
      "/app/.next/cache",
      "/home/node/.npm",
      "/root/.npm"
    ]);
  });

  it("generates the Prisma client exactly once", () => {
    expect([...dockerfile.matchAll(/^RUN .*prisma generate/gm)]).toHaveLength(1);
    expect(stage("runner-dependencies")).toContain("RUN npx --no-install prisma generate");
  });

  it("installs runtime dependencies from the lockfile instead of pruning the builder's node_modules", () => {
    const runtime = stage("runner-dependencies");
    expect(runtime).toContain("RUN --mount=type=cache,target=/home/node/.npm,uid=1000,gid=1000 npm ci --omit=dev --ignore-scripts");
    expect(runtime).toContain("COPY --chown=node:node prisma ./prisma");
    expect(runtime).not.toContain("node_modules ./node_modules");
    expect(dockerfile).not.toContain("npm prune");
  });

  it("installs and copies runtime files as node instead of rewriting /app ownership every build", () => {
    const runtime = stage("runner-dependencies");
    expect(runtime).toContain("RUN mkdir -p /var/lib/cubby/sprout-staging && chown -R node:node /app /var/lib/cubby");
    // The chown must run while /app is still empty: before the dependency install and every COPY.
    expect(runtime.indexOf("chown -R node:node /app")).toBeLessThan(runtime.indexOf("USER node"));
    expect(runtime.indexOf("USER node")).toBeLessThan(runtime.indexOf("npm ci"));
    expect([...dockerfile.matchAll(/^RUN .*chown -R/gm)]).toHaveLength(1);
    // Every runtime file lands owned by node at copy time, in place of a recursive chown afterwards.
    const runtimeStages = ["runner-dependencies", "runner-public", "runner-standalone", "runner-static", "runner-runtime-artifacts"];
    const runtimeCopies = runtimeStages
      .flatMap((name) => stage(name).split(/\r?\n/))
      .filter((line) => line.startsWith("COPY ") && !line.includes("/usr/local/bin/"));
    expect(runtimeCopies.length).toBeGreaterThan(10);
    for (const copy of runtimeCopies) expect(copy, copy).toContain("--chown=node:node");
    expect(stage("runner-filesystem")).toContain("test -O /var/lib/cubby/sprout-staging");
    expect(stage("runner").trimEnd().endsWith("ENTRYPOINT [\"/usr/local/bin/cubby-entrypoint\"]")).toBe(true);
    expect(stage("runner")).toMatch(/USER root[\s\S]*USER node/);
  });

  it("keeps the Prisma CLI a runtime dependency, because the entrypoint runs migrate deploy", () => {
    expect(packageJson.dependencies.prisma).toBeTruthy();
    expect(packageJson.devDependencies.prisma).toBeUndefined();
    expect(read("docker/entrypoint.sh")).toContain("node node_modules/prisma/build/index.js migrate deploy");
  });

  it("keeps build output out of the build context so the mounted caches are authoritative", () => {
    expect(dockerignore).toMatch(/^node_modules\r?$/m);
    expect(dockerignore).toMatch(/^\.next\r?$/m);
  });
});
