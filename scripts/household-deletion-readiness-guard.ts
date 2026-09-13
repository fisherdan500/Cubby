import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const guardPath = fileURLToPath(import.meta.url);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const marker = "household_deletion_deferred_fail_closed";

/**
 * This candidate deliberately has no invitation-protocol household-delete path.
 * Keep the names concrete: this is an absence assertion, never an authorization
 * mechanism or a substitute for the separately reviewed containment protocol.
 */
export const householdDeletionDeferredFailClosedForbiddenSurfaces = [
  "InvitationHouseholdDeleteAuthorization",
  "invitation_household_delete_authorization",
  "delete_household_with_invitation_containment_v2",
  "issue_invitation_household_delete_authorization_v2",
  "cubby_household_delete_runtime",
  "HOUSEHOLD_DELETE_DATABASE_URL",
  "CUBBY_HOUSEHOLD_DELETE_DB_PASSWORD",
  "householdDeleteDatabaseUrl",
  "invitation-household-delete-prisma",
  "invitation.household.contain",
  "api/households/delete",
] as const;

const candidateRoots = [
  "prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql",
  "Dockerfile",
  "docker-compose.yml",
  "docker/entrypoint.sh",
  ".env.example",
  "package.json",
  "scripts",
  "src/lib/db",
  "src/server/services",
  "src/app/api",
] as const;

function sourceFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    if (entry.isFile() && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx") && !entry.name.endsWith(".operation.ts") && !entry.name.endsWith(".acceptance-rehearsal.ts")) return [child];
    return [];
  });
}

function isReadinessValidationArtifact(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.endsWith("/scripts/household-deletion-readiness-guard.ts")
    || normalized.endsWith("/scripts/household-deletion-readiness-guard.mjs")
    || normalized.endsWith("/dist/household-deletion-readiness-guard.mjs")
    // The disposable runtime probe proves the same surfaces absent. It is not
    // an authority implementation and cannot be scanned as one.
    || normalized.endsWith("/scripts/p1-3-invitation.runtime-probe.ts");
}

export function householdDeletionCandidateSourceFiles() {
  return candidateRoots.flatMap((path) => {
    const absolute = resolve(root, path);
    if (!existsSync(absolute)) return [];
    return statSync(absolute).isDirectory() ? sourceFiles(absolute) : [absolute];
  }).filter((path) => path !== guardPath && !isReadinessValidationArtifact(path));
}

export function assertHouseholdDeletionDeferredFailClosed() {
  const migration = readFileSync(resolve(root, "prisma/migrations/20260904120000_invitation_protocol_v2/migration.sql"), "utf8");
  if (!migration.includes(marker)) throw new Error("household_deletion_readiness_marker_missing");

  for (const path of householdDeletionCandidateSourceFiles()) {
    const source = `${path.replaceAll("\\", "/")}\n${readFileSync(path, "utf8")}`;
    const forbidden = householdDeletionDeferredFailClosedForbiddenSurfaces.find((value) => source.includes(value));
    if (forbidden) throw new Error(`household_deletion_readiness_forbidden_surface:${forbidden}`);
  }
}

if (process.env.VITEST !== "true") {
  try {
    assertHouseholdDeletionDeferredFailClosed();
  } catch {
    process.stderr.write("cubby_startup phase=household_deletion_readiness status=failed\n");
    process.exit(1);
  }
}
