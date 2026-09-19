import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const entrypoint = new URL("../../../docker/entrypoint.sh", import.meta.url).pathname.replace(
  /^\/(\w:)/,
  "$1"
);
const dockerfilePath = new URL("../../../Dockerfile", import.meta.url);
const packageJsonPath = new URL("../../../package.json", import.meta.url);
const nodeBuiltinProbePath = new URL("../../../scripts/p1-3-node-builtin-probe.mjs", import.meta.url);
const standaloneBootstrapProbePath = new URL("../../../scripts/p1-3-standalone-bootstrap-probe.cjs", import.meta.url);
const workerRuntime = new URL("../../../../../../worker-runtime/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const sh = process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\sh.exe" : "sh";

function runEntrypoint(migrationExit = 0) {
  mkdirSync(workerRuntime, { recursive: true });
  const directory = mkdtempSync(join(workerRuntime, "cubby-entrypoint-"));
  const log = join(directory, "commands.log");
  const environmentLog = join(directory, "environment.log");
  const fakeNode = join(directory, "node");
  const launcher = join(directory, "launcher.sh");
  writeFileSync(
    fakeNode,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CUBBY_TEST_LOG"\nprintf '%s key=%s migrator=%s runtime=%s auth=%s delivery=%s operator=%s operator_url=%s\\n' "$1" "\${CUBBY_THROTTLE_KEY:+present}" "\${CUBBY_MIGRATOR_DB_PASSWORD:+present}" "\${CUBBY_RUNTIME_DB_PASSWORD:+present}" "\${CUBBY_AUTH_DB_PASSWORD:+present}" "\${CUBBY_EMAIL_DELIVERY_DB_PASSWORD:+present}" "\${CUBBY_SECURITY_OPERATOR_DB_PASSWORD:+present}" "\${SECURITY_OPERATOR_DATABASE_URL:+present}" >> "$CUBBY_TEST_ENVIRONMENT_LOG"\nif [ "$1" = "node_modules/prisma/build/index.js" ]; then\n  printf '%s\\n' 'inherited output with postgresql://secret@private-host'\n  exit "$CUBBY_MIGRATION_EXIT"\nfi\nprintf 'entrypoint_pid=%s server_pid=%s\\n' "$CUBBY_EXPECTED_PID" "$$"\n`
  );
  chmodSync(fakeNode, 0o755);
  writeFileSync(launcher, '#!/bin/sh\nexport CUBBY_EXPECTED_PID="$$"\nexec sh "$1"\n');
  chmodSync(launcher, 0o755);

  const result = spawnSync(sh, [launcher, entrypoint], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
      CUBBY_TEST_LOG: log,
      CUBBY_TEST_ENVIRONMENT_LOG: environmentLog,
      CUBBY_MIGRATION_EXIT: String(migrationExit),
      MIGRATION_DATABASE_URL: "postgresql://migration-owner@private-host/cubby",
      DATABASE_URL: "postgresql://runtime@private-host/cubby",
      AUTH_DATABASE_URL: "postgresql://cubby_auth@private-host/cubby",
      EMAIL_DELIVERY_DATABASE_URL: "postgresql://cubby_email_delivery@private-host/cubby",
      INVITATION_DATABASE_URL: "postgresql://cubby_invitation_runtime:invitation-password@private-host/cubby",
      INVITATION_EXPIRY_DATABASE_URL: "postgresql://cubby_invitation_expiry_worker:expiry-password@private-host/cubby",
      INVITATION_MAINTENANCE_DATABASE_URL: "postgresql://cubby_invitation_maintenance_worker:maintenance-password@private-host/cubby",

      CUBBY_THROTTLE_KEY: Buffer.alloc(32, 3).toString("base64url"),
      CUBBY_TRUSTED_PROXY_HOPS: "1",
      CUBBY_MIGRATOR_DB_PASSWORD: "migrator-password",
      CUBBY_RUNTIME_DB_PASSWORD: "runtime-password",
      CUBBY_AUTH_DB_PASSWORD: "auth-password",
      CUBBY_EMAIL_DELIVERY_DB_PASSWORD: "delivery-password",
      CUBBY_INVITATION_RUNTIME_DB_PASSWORD: "invitation-password",
      CUBBY_INVITATION_EXPIRY_DB_PASSWORD: "expiry-password",
      CUBBY_INVITATION_MAINTENANCE_DB_PASSWORD: "maintenance-password",
      CUBBY_SECURITY_OPERATOR_DB_PASSWORD: "operator-password",
      SECURITY_OPERATOR_DATABASE_URL: "postgresql://cubby_security_operator:operator-password@private-host/cubby"
    }
  });

  const commands = readFileSync(log, "utf8");
  const environment = readFileSync(environmentLog, "utf8");
  rmSync(directory, { recursive: true, force: true });
  return { ...result, commands, environment };
}

describe("container entrypoint contract", () => {
  it("normalizes the copied entrypoint before direct Linux execution", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const copy = "COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/cubby-entrypoint";
    const normalize = String.raw`RUN sed -i 's/\x0D$//' /usr/local/bin/cubby-entrypoint`;
    const execute = 'ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]';

    expect(dockerfile).toContain(copy);
    expect(dockerfile).toContain(normalize);
    expect(dockerfile.indexOf(copy)).toBeLessThan(dockerfile.indexOf(normalize));
    expect(dockerfile.indexOf(normalize)).toBeLessThan(dockerfile.indexOf(execute));
  });

  it("builds and runs the readiness guard's generated ESM before the application build", () => {
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const buildGuard = "RUN npm run build:household-deletion-readiness";
    const runGuard = "RUN node dist/household-deletion-readiness-guard.mjs";
    // The application build generates the Prisma client itself; see image-build-cache-contract.
    const build = dockerfile.search(/^RUN (?:--mount=\S+ )*npm run build\r?$/m);

    expect(dockerfile).toContain(buildGuard);
    expect(dockerfile).toContain(runGuard);
    expect(build).toBeGreaterThan(0);
    expect(dockerfile.indexOf(buildGuard)).toBeLessThan(dockerfile.indexOf(runGuard));
    expect(dockerfile.indexOf(runGuard)).toBeLessThan(build);
  });

  it("runs migrations before starting the server", () => {
    const result = runEntrypoint();

    expect(result.status).toBe(0);
    expect(result.commands.trim().split("\n")).toEqual([
      "/app/scripts/household-deletion-readiness-guard.mjs",
      "provision-security-runtime-role.mjs",
      "provision-invitation-runtime-roles.mjs",
      "provision-database-timezone.mjs",
      "node_modules/prisma/build/index.js db execute --stdin --schema prisma/schema.prisma",
      "node_modules/prisma/build/index.js migrate deploy",
      "provision-fresh-auth-attestation-keys.mjs",
      "provision-email-delivery-keys.mjs",
      "provision-global-security-throttle-key.mjs",
      "provision-platform-setup-code.mjs",
      "server.js"
    ]);
  });

  it("keeps the setup-code step's stdout for the operator but still discards its stderr", () => {
    const source = readFileSync(entrypoint, "utf8");
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };

    expect(source).toContain('DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-platform-setup-code.mjs 2>/dev/null; then');
    expect(source).not.toMatch(/provision-platform-setup-code\.mjs >\/dev\/null/);
    expect(source.indexOf("provision-global-security-throttle-key.mjs")).toBeLessThan(source.indexOf("provision-platform-setup-code.mjs"));
    expect(source.indexOf("provision-platform-setup-code.mjs")).toBeLessThan(source.indexOf("write_startup_status migration succeeded"));
    expect(packageJson.scripts?.["build:platform-setup-code"]).toContain("scripts/provision-platform-setup-code.mjs");
    expect(packageJson.scripts?.build).toContain("npm run build:platform-setup-code");
    expect(dockerfile).toContain("dist/provision-platform-setup-code.mjs ./provision-platform-setup-code.mjs");
  });

  it("emits fixed migration success markers and execs the server", () => {
    const result = runEntrypoint();

    expect(result.stdout).toContain("cubby_startup phase=migration status=starting");
    expect(result.stdout).toContain("cubby_startup phase=migration status=succeeded");
    expect(result.stdout).toContain("cubby_startup phase=server status=starting");
    expect(result.stdout).toMatch(/entrypoint_pid=(\d+) server_pid=\1/);
  });

  it("permits only the fixed synthetic startup-status surface", () => {
    const source = readFileSync(entrypoint, "utf8");
    const nodeBuiltinProbe = readFileSync(nodeBuiltinProbePath, "utf8");
    const standaloneBootstrapProbe = readFileSync(standaloneBootstrapProbePath, "utf8");
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const acceptanceCompose = readFileSync(new URL("../../../scripts/p1-3-invitation.acceptance.compose.yml", import.meta.url), "utf8");

    expect(source).toContain("write_startup_status");
    expect(source).toContain("/run/cubby-acceptance-status/startup");
    expect(source).toContain("CUBBY_STARTUP_STATUS_FILE");
    expect(source).toContain("CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE");
    expect(source).toContain("/run/cubby-acceptance-status/instrumentation-stage");
    expect(source).toContain("node /app/scripts/p1-3-node-builtin-probe.mjs >/dev/null 2>&1");
    expect(nodeBuiltinProbe).toContain('process.getBuiltinModule("fs")');
    expect(nodeBuiltinProbe).not.toMatch(/console\.|process\.stdout|process\.stderr/);
    expect(source).toContain("node_builtin_ready");
    expect(source).not.toContain("CUBBY_P13_ACCEPTANCE_BOOTSTRAP_PRELOAD");
    expect(acceptanceCompose).not.toContain("CUBBY_P13_ACCEPTANCE_BOOTSTRAP_PRELOAD");
    expect(source).toContain("bootstrap_exec_selected");
    expect(source).toContain("exec node --require /app/scripts/p1-3-standalone-bootstrap-probe.cjs server.js");
    expect(source.indexOf("bootstrap_exec_selected")).toBeLessThan(
      source.indexOf("exec node --require /app/scripts/p1-3-standalone-bootstrap-probe.cjs server.js")
    );
    expect(dockerfile).toContain("COPY --chown=node:node scripts/p1-3-standalone-bootstrap-probe.cjs /app/scripts/p1-3-standalone-bootstrap-probe.cjs");
    expect(standaloneBootstrapProbe).not.toContain("CUBBY_P13_ACCEPTANCE_BOOTSTRAP_PRELOAD");
    expect(standaloneBootstrapProbe).toContain('const stageFile = "/run/cubby-acceptance-status/instrumentation-stage"');
    expect(standaloneBootstrapProbe).toContain("process.env.CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE === stageFile");
    expect(standaloneBootstrapProbe).toContain('const stages = Object.freeze([');
    for (const stage of [
      "preload_file_loaded",
      "preload_guards_confirmed",
      "standalone_server_module_entered",
      "next_package_loaded",
      "start_server_module_loaded",
      "start_server_invoked",
      "next_server_module_loaded",
      "instrumentation_module_load_requested"
    ]) expect(standaloneBootstrapProbe).toContain(`"${stage}"`);
    expect(standaloneBootstrapProbe.indexOf('advance("preload_file_loaded")')).toBeLessThan(
      standaloneBootstrapProbe.indexOf("process.env.CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE === stageFile")
    );
    expect(standaloneBootstrapProbe.indexOf("process.env.CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE === stageFile")).toBeLessThan(
      standaloneBootstrapProbe.indexOf('advance("preload_guards_confirmed")')
    );
    expect(standaloneBootstrapProbe).toContain('process.getBuiltinModule("module")');
    expect(standaloneBootstrapProbe).not.toMatch(/console\.|process\.stdout|process\.stderr|readFile|readdir/);
  });

  it("fails closed with a fixed sanitized marker when migration fails", () => {
    const result = runEntrypoint(42);
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(result.commands.trim().split("\n")).toEqual([
      "/app/scripts/household-deletion-readiness-guard.mjs",
      "provision-security-runtime-role.mjs",
      "provision-invitation-runtime-roles.mjs",
      "provision-database-timezone.mjs",
      "node_modules/prisma/build/index.js db execute --stdin --schema prisma/schema.prisma"
    ]);
    expect(output).toContain("cubby_startup phase=migration_connection status=failed");
    expect(output).not.toContain("server status=starting");
    expect(output).not.toContain("postgresql://");
    expect(output).not.toContain("private-host");
  });

  it("runs migrations with the explicitly separate migration connection", () => {
    const source = readFileSync(entrypoint, "utf8");

    expect(source).toContain('DATABASE_URL="$MIGRATION_DATABASE_URL" node node_modules/prisma/build/index.js migrate deploy');
    expect(source).toContain('MIGRATION_DATABASE_URL:-');
  });

  it("provisions distinct least-privilege auth and email-delivery roles and retains their runtime URLs", () => {
    const source = readFileSync(entrypoint, "utf8");
    const provisioner = readFileSync(new URL("../../../scripts/provision-security-runtime-role.mjs", import.meta.url), "utf8");
    expect(source).toContain('CUBBY_AUTH_DATABASE_URL="$AUTH_DATABASE_URL"');
    expect(source).toContain('CUBBY_EMAIL_DELIVERY_DATABASE_URL="$EMAIL_DELIVERY_DATABASE_URL"');
    expect(source).toContain('DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-invitation-runtime-roles.mjs');
    expect(source).toContain("unset CUBBY_INVITATION_RUNTIME_DB_PASSWORD CUBBY_INVITATION_EXPIRY_DB_PASSWORD CUBBY_INVITATION_MAINTENANCE_DB_PASSWORD");
    expect(source).toContain("CUBBY_AUTH_DB_PASSWORD");
    expect(source).toContain("CUBBY_EMAIL_DELIVERY_DB_PASSWORD");
    expect(source).not.toMatch(/unset[^\n]*AUTH_DATABASE_URL/);
    expect(source).not.toMatch(/unset[^\n]*EMAIL_DELIVERY_DATABASE_URL/);
    expect(provisioner).toContain("cubby_auth");
    expect(provisioner).toContain("cubby_email_delivery");
    expect(provisioner).toContain("new Set(roles.map(({ password }) => password)).size !== roles.length");
  });

  it("provisions the operator before migrations, scrubs its password, and retains no operator URL in server runtime", () => {
    const result = runEntrypoint();
    const source = readFileSync(entrypoint, "utf8");
    const dockerfile = readFileSync(dockerfilePath, "utf8");
    const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { scripts?: Record<string, string> };

    expect(source.indexOf("provision-security-runtime-role.mjs")).toBeLessThan(source.indexOf("provision-invitation-runtime-roles.mjs"));
    expect(source.indexOf("provision-invitation-runtime-roles.mjs")).toBeLessThan(source.indexOf("migrate deploy"));
    expect(source.indexOf("migrate deploy")).toBeLessThan(source.indexOf("provision-global-security-throttle-key.mjs"));
    expect(source).toContain('CUBBY_THROTTLE_KEY="$cubby_throttle_key" DATABASE_URL="$MIGRATION_DATABASE_URL" node provision-global-security-throttle-key.mjs');
    expect(source).toContain('export CUBBY_THROTTLE_KEY="$cubby_throttle_key"');
    expect(source).toContain("exec node server.js");
    expect(source).toContain("unset CUBBY_THROTTLE_KEY");
    expect(source).toContain("CUBBY_SECURITY_OPERATOR_DB_PASSWORD");
    expect(source).toContain("unset CUBBY_SECURITY_OPERATOR_DB_PASSWORD");
    expect(source).toContain("unset SECURITY_OPERATOR_DATABASE_URL");
    expect(compose).toContain("CUBBY_THROTTLE_KEY:");
    expect(compose).toContain("CUBBY_TRUSTED_PROXY_HOPS:");
    expect(compose).toContain("CUBBY_SECURITY_OPERATOR_DB_PASSWORD");
    expect(compose).not.toContain("SECURITY_OPERATOR_DATABASE_URL");
    expect(packageJson.scripts?.["build:security-operator"]).toContain("scripts/security-operator.ts");
    expect(dockerfile).toContain("dist/security-operator.mjs");
    expect(packageJson.scripts?.["build:global-security-throttle-key"]).toContain("provision-global-security-throttle-key.mjs");
    expect(dockerfile).toContain("dist/provision-global-security-throttle-key.mjs");
    expect(packageJson.scripts?.["build:household-deletion-readiness"]).toContain("household-deletion-readiness-guard.mjs");
    expect(dockerfile).toContain("dist/household-deletion-readiness-guard.mjs");
    expect(result.environment.trim().split("\n")).toEqual([
      "/app/scripts/household-deletion-readiness-guard.mjs key=present migrator=present runtime=present auth=present delivery=present operator=present operator_url=present",
      "provision-security-runtime-role.mjs key= migrator= runtime= auth= delivery= operator=present operator_url=",
      "provision-invitation-runtime-roles.mjs key= migrator= runtime= auth= delivery= operator=present operator_url=",
      "provision-database-timezone.mjs key= migrator= runtime= auth= delivery= operator= operator_url=",
      "node_modules/prisma/build/index.js key= migrator= runtime= auth= delivery= operator= operator_url=",
      "node_modules/prisma/build/index.js key= migrator= runtime= auth= delivery= operator= operator_url=",
      "provision-fresh-auth-attestation-keys.mjs key= migrator= runtime= auth= delivery= operator= operator_url=",
      "provision-email-delivery-keys.mjs key= migrator= runtime= auth= delivery= operator= operator_url=",
      "provision-global-security-throttle-key.mjs key=present migrator= runtime= auth= delivery= operator= operator_url=",
      "provision-platform-setup-code.mjs key= migrator= runtime= auth= delivery= operator= operator_url=",
      "server.js key=present migrator= runtime= auth= delivery= operator= operator_url="
    ]);
  });

  it("has no legacy package-script startup path around the entrypoint", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["docker:start"]).toBeUndefined();
  });

  it("documents only the child-scoped Compose security-operator invocation", () => {
    const development = readFileSync(new URL("../../../docs/DEVELOPMENT.md", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    const invocation = "docker compose exec -T -e SECURITY_OPERATOR_DATABASE_URL=... app node /app/security-operator.mjs aggregate";
    expect(development).toContain(invocation);
    expect(readme).toContain(invocation);
    expect(development).not.toContain("node dist/security-operator.mjs aggregate");
  });
});
