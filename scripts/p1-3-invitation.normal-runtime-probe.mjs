import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Current non-effect baseline. The historical Attempt 4 record is preserved unmodified and is no
// longer read here, so refreshing the baseline never rewrites attempt evidence. Absence fails closed.
const baselinePath = resolve(root, "..", "..", "..", "worker-runtime", "p1-3-invitation-normal-runtime-baseline.json");

const normalize = (value) => value.replaceAll("\\", "/");
const sortedMounts = (mounts) => mounts
  .map(([type, name, source, destination, writable]) => [type, name, normalize(source), destination, writable])
  .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

export function p13InvitationNormalRuntimeMatches(baseline, observed) {
  for (const service of ["app", "postgres"]) {
    const expected = baseline?.[service];
    const actual = observed?.[service];
    if (!expected || !actual || !Array.isArray(expected.mounts) || !Array.isArray(actual.identity) || !Array.isArray(actual.mounts)) return false;
    if (actual.identity.length !== 5 || actual.identity[0] !== expected.containerId || actual.identity[1] !== expected.imageId || actual.identity[2] !== "true" || actual.identity[3] !== expected.health || actual.identity[4] !== String(expected.restartCount)) return false;
    if (JSON.stringify(sortedMounts(actual.mounts)) !== JSON.stringify(sortedMounts(expected.mounts))) return false;
  }
  return true;
}

function readFormattedDockerFields(containerId, format) {
  const result = spawnSync("docker", ["inspect", "--format", format, containerId], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16_384
  });
  return result.error || result.status !== 0 ? undefined : result.stdout;
}

function parseIdentity(value) {
  const fields = value.trimEnd().split("\t");
  return fields.length === 5 && fields.every((field) => field.length > 0) ? fields : undefined;
}

function parseMounts(value) {
  if (value === "") return [];
  const rows = value.trimEnd().split("\n");
  const mounts = [];
  for (const row of rows) {
    const [type, name, source, destination, writable, ...extra] = row.split("\t");
    if (extra.length !== 0 || !type || source === undefined || !destination || (writable !== "true" && writable !== "false")) return undefined;
    mounts.push([type, name ?? "", source, destination, writable === "true"]);
  }
  return mounts;
}

function observe(containerId) {
  const identity = readFormattedDockerFields(containerId, "{{.Id}}\t{{.Image}}\t{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.RestartCount}}");
  const mounts = readFormattedDockerFields(containerId, "{{range .Mounts}}{{.Type}}\t{{.Name}}\t{{.Source}}\t{{.Destination}}\t{{.RW}}\n{{end}}");
  if (identity === undefined || mounts === undefined) return undefined;
  const parsedIdentity = parseIdentity(identity);
  const parsedMounts = parseMounts(mounts);
  return parsedIdentity && parsedMounts ? { identity: parsedIdentity, mounts: parsedMounts } : undefined;
}

function main() {
  if (!existsSync(baselinePath)) return false;
  let baseline;
  try { baseline = JSON.parse(readFileSync(baselinePath, "utf8"))?.normalRuntime; } catch { return false; }
  if (!baseline?.app?.containerId || !baseline?.postgres?.containerId) return false;
  const observed = { app: observe(baseline.app.containerId), postgres: observe(baseline.postgres.containerId) };
  return p13InvitationNormalRuntimeMatches(baseline, observed);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const matched = main();
  process.stdout.write(matched ? "p1_3_invitation_acceptance_normal_runtime_match\n" : "p1_3_invitation_acceptance_normal_runtime_mismatch\n");
  process.exitCode = matched ? 0 : 1;
}
