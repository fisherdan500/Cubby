import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createTlsServer } from "node:tls";
import { createServer as createHttpServer } from "node:http";
import { PrismaClient } from "@prisma/client";
import { env as runtimeEnv } from "../src/lib/env";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthEndpoint } from "@better-auth/core/api";
import { acknowledgeRecoveryCodeSetSaved, beginRecoveryReset, getRecoveryEnrollmentStatus, getRecoveryResetStatus, issueRecoveryCodeSet, recoverPasswordWithCode, rehearseRecoveryCodeSet } from "../src/server/services/recovery-lifecycle";
import { captureGlobalSecurityContext, changePasswordWithCurrentPassword, issueFreshAuthGrantForCurrentPassword } from "../src/server/services/global-security";
import { createFreshAuthAttestationSigner } from "../src/server/services/fresh-auth-attestation";
import { authorizeGlobalSessionSecurity, createGlobalSessionHandle, createSessionRevokeIntentFingerprint, getGlobalSessionRevokeStatus, initializeGlobalSessionSecurityActivity, listGlobalSessionSecurity, recordQualifyingGlobalSessionUseAfterSuccess, revokeGlobalSessionSecurityWithCurrentPassword, type SessionRevokeScope } from "../src/server/services/global-session-security";
import { cancelVerifiedEmailChange, completeVerifiedEmailChange, confirmEmailChangeRotationCookie, confirmEmailChangeSuccessorCookieForAuthenticatedSession, emitEmailChangeSuccessorCookie, expireVerifiedEmailChange, failEmailChangeRotationCookie, initiateVerifiedEmailChange, verifyEmailChangeToken } from "../src/server/services/email-change";
import { createEmailDeliveryCipher, dispatchEmailChangeDelivery } from "../src/server/services/email-change-delivery";
import { createSmtpEmailDeliveryAdapter } from "../src/server/services/smtp-email-delivery";
import { listGlobalSecurityHistory, exportGlobalSecurityHistory } from "../src/server/services/global-security-history";
import { precheckGlobalSecurityThrottle, recordGlobalSecurityThrottleFailure, recordGlobalSecurityThrottleFailureInTransaction, writeGlobalSecurityEvent } from "../src/server/services/global-security-throttling";
import { runEmailSignInThrottleCarrier } from "../src/server/services/sign-in-email-throttle";
import { runEmailChangeLifecycleWorkerTick } from "../src/server/services/email-change-lifecycle-worker";
import { runP13EmailChangeBrowserAcceptance } from "./p1-3-email-change-browser.acceptance-rehearsal";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerRuntime = resolve(root, "..", "..", "..", "worker-runtime");
const composeFile = "scripts/browser-operation-pilot.acceptance.compose.yml";

async function startPhase6BetterAuthApplication(input: { database: PrismaClient; authDatabase: PrismaClient; success: { userId: string; operationId: string; sessionId: string; token: string }; failure: { userId: string; operationId: string; sessionId: string; token: string } }) {
  let acceptanceAuth: { handler: (request: Request) => Promise<Response>; api: { getSession: (input: { headers: Headers; query: { disableCookieCache: boolean } }) => Promise<{ user: { id: string }; session: { id: string; token: string } } | null> } } | undefined;
  const server = createHttpServer(async (request, response) => {
    try {
      if (request.url === "/") {
        response.setHeader("content-type", "text/html");
        response.setHeader("cache-control", "no-store");
        response.end(`<!doctype html><meta charset="utf-8"><script>(async()=>{const emitted=await fetch('/api/auth/p1-3/emit',{method:'POST'}).then(r=>r.json());const confirmed=await fetch('/api/auth/p1-3/confirm',{method:'POST'}).then(r=>r.json());const failed=await fetch('/api/auth/p1-3/emit-fail',{method:'POST'}).then(r=>r.json());window.p13EmailChangeResult={emitted:emitted.status,confirmed:confirmed.status,failed:failed.status,storageCount:localStorage.length+sessionStorage.length};})().catch(()=>{window.p13EmailChangeResult={emitted:'error'};});</script>`);
        return;
      }
      if (!acceptanceAuth) throw new Error("phase6_better_auth_not_ready");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const webRequest = new Request(`${origin}${request.url}`, { method: request.method, headers: request.headers as HeadersInit, body: chunks.length ? Buffer.concat(chunks) : undefined });
      const webResponse = await acceptanceAuth.handler(webRequest);
      response.statusCode = webResponse.status;
      webResponse.headers.forEach((value, key) => { if (key.toLowerCase() !== "set-cookie") response.setHeader(key, value); });
      const setCookies = (webResponse.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      if (setCookies.length) response.setHeader("set-cookie", setCookies);
      response.end(Buffer.from(await webResponse.arrayBuffer()));
    } catch {
      response.statusCode = 500;
      response.end('{"status":"unavailable"}');
    }
  });
  await new Promise<void>((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("phase6_better_auth_loopback_bind_failed");
  const origin = `http://127.0.0.1:${address.port}`;
  const cookiePayload = async (fixture: typeof input.success) => {
    const [session, user] = await Promise.all([input.authDatabase.session.findUniqueOrThrow({ where: { id: fixture.sessionId } }), input.authDatabase.user.findUniqueOrThrow({ where: { id: fixture.userId } })]);
    return { session, user };
  };
  const plugin = {
    id: "p1-3-email-change-acceptance",
    endpoints: {
      emit: createAuthEndpoint("/p1-3/emit", { method: "POST" }, async (ctx) => {
        const payload = await cookiePayload(input.success);
        return ctx.json(await emitEmailChangeSuccessorCookie(input.database, { userId: input.success.userId, operationId: input.success.operationId, successorSessionId: input.success.sessionId, successorToken: input.success.token, cookieContext: ctx, session: payload.session, user: payload.user }));
      }),
      confirm: createAuthEndpoint("/p1-3/confirm", { method: "POST", requireHeaders: true }, async (ctx) => {
        const authenticated = await acceptanceAuth!.api.getSession({ headers: ctx.headers, query: { disableCookieCache: true } });
        if (!authenticated?.user?.id || !authenticated.session?.id || !authenticated.session.token) return ctx.json({ status: "unauthenticated" });
        const security = await captureGlobalSecurityContext(input.database, { userId: authenticated.user.id, sessionId: authenticated.session.id });
        return ctx.json(await confirmEmailChangeSuccessorCookieForAuthenticatedSession(input.database, { ...security, sessionToken: authenticated.session.token }, { operationId: input.success.operationId }));
      }),
      emitFailure: createAuthEndpoint("/p1-3/emit-fail", { method: "POST" }, async (ctx) => {
        const payload = await cookiePayload(input.failure);
        return ctx.json(await emitEmailChangeSuccessorCookie(input.database, { userId: input.failure.userId, operationId: input.failure.operationId, successorSessionId: input.failure.sessionId, successorToken: input.failure.token, cookieContext: ctx, session: payload.session, user: payload.user }, { setCookie: async () => { throw new Error("synthetic_cookie_emission_failure"); } }));
      })
    }
  };
  const createdAuth = betterAuth({ database: prismaAdapter(input.authDatabase, { provider: "postgresql" }), secret: randomBytes(32).toString("base64url"), baseURL: origin, trustedOrigins: [origin], session: { expiresIn: 60 * 60 * 24 * 60, updateAge: 60 * 60 * 24, cookieCache: { enabled: true, maxAge: 60 } }, plugins: [plugin] });
  acceptanceAuth = { handler: createdAuth.handler, api: { getSession: (request) => createdAuth.api.getSession(request) } };
  return { origin, close: () => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())) };
}

async function startSyntheticSmtp(input: { key: Buffer; cert: Buffer; username: string; password: string; recipient: string }) {
  const accepted: Array<{ recipient: string; messageId: string | null }> = [];
  const server = createTlsServer({ key: input.key, cert: input.cert }, (socket) => {
    socket.setEncoding("utf8");
    socket.write("220 synthetic.cubby.local ESMTP\r\n");
    let buffered = "";
    let dataMode = false;
    const processLines = () => {
      if (dataMode) {
        const end = buffered.indexOf("\r\n.\r\n");
        if (end < 0) return;
        const message = buffered.slice(0, end);
        buffered = buffered.slice(end + 5);
        const messageId = message.match(/^Message-ID:\s*(.+)$/im)?.[1]?.trim() ?? null;
        accepted.push({ recipient: input.recipient, messageId });
        dataMode = false;
        socket.write("250 2.0.0 accepted\r\n");
      }
      while (!dataMode) {
        const end = buffered.indexOf("\r\n");
        if (end < 0) return;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (/^(EHLO|HELO)\b/i.test(line)) socket.write("250-synthetic.cubby.local\r\n250-AUTH PLAIN\r\n250 SIZE 1048576\r\n");
        else if (/^AUTH PLAIN\s+/i.test(line)) {
          const decoded = Buffer.from(line.replace(/^AUTH PLAIN\s+/i, ""), "base64").toString("utf8").split("\0");
          socket.write(decoded.at(-2) === input.username && decoded.at(-1) === input.password ? "235 2.7.0 authenticated\r\n" : "535 5.7.8 invalid\r\n");
        } else if (/^MAIL FROM:/i.test(line)) socket.write("250 2.1.0 sender ok\r\n");
        else if (/^RCPT TO:/i.test(line)) socket.write(line.toLowerCase().includes(input.recipient.toLowerCase()) ? "250 2.1.5 recipient ok\r\n" : "550 5.1.1 rejected\r\n");
        else if (/^DATA$/i.test(line)) { dataMode = true; socket.write("354 end with <CRLF>.<CRLF>\r\n"); }
        else if (/^QUIT$/i.test(line)) { socket.end("221 2.0.0 bye\r\n"); return; }
        else socket.write("250 2.0.0 ok\r\n");
      }
    };
    socket.on("data", (chunk) => { buffered += chunk; processLines(); });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("phase6_smtp_loopback_bind_failed");
  return {
    port: address.port,
    accepted,
    close: () => new Promise<void>((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  };
}

function redact(value: string, env: NodeJS.ProcessEnv) {
  let result = value;
  for (const [key, secret] of Object.entries(env)) {
    if (secret && (key.includes("PASSWORD") || key.includes("DATABASE_URL") || key.includes("SECRET"))) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
  }
  return result;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, capture = false, code = "p1_3_phase1_acceptance_command_failed", cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore"
  });
  if (result.error || result.status !== 0) {
    if (capture) process.stderr.write(redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, env).slice(-12_000));
    throw new Error(code);
  }
  return String(result.stdout ?? "").trim();
}

function acceptanceEnv(user: string, database: string, password: string) {
  const env = {} as NodeJS.ProcessEnv;
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    COMPOSE_DISABLE_ENV_FILE: "true",
    NODE_ENV: "test",
    CUBBY_BROWSER_OPERATION_ACCEPTANCE_USER: user,
    CUBBY_BROWSER_OPERATION_ACCEPTANCE_DATABASE: database,
    CUBBY_BROWSER_OPERATION_ACCEPTANCE_PASSWORD: password
  });
  return env;
}

function canonicalizeGlobalSecurityFixtureIds(statement: string) {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  return statement.replace(/'([^']+)'/g, (whole, value: string) => {
    if (!value.includes("-") || !/(operation|recovery|stale|ordinary|carrier)/.test(value)) return whole;
    const digest = createHash("sha256").update(value).digest();
    return `'gso_${Array.from(digest.subarray(0, 26), (byte) => alphabet[byte & 31]).join("")}'`;
  });
}

function copyTrackedPrisma(destination: string, env: NodeJS.ProcessEnv) {
  const candidateMigrations = [
    "prisma/migrations/20260824140000_global_security_foundation/migration.sql",
    "prisma/migrations/20260829120000_global_security_throttle_core/migration.sql",
    "prisma/migrations/20260829170000_global_security_phase8_carriers/migration.sql",
    "prisma/migrations/20260829190000_global_security_private_history_reader/migration.sql",
    "prisma/migrations/20260829200000_global_security_operator_aggregate/migration.sql",
    "prisma/migrations/20260829210000_global_security_phase8_review_remediation/migration.sql"
  ];
  const result = spawnSync("git", ["ls-files", "-z", "--", "prisma/schema.prisma", "prisma/migrations"], {
    cwd: root,
    env,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0) throw new Error("p1_3_phase1_tracked_prisma_inventory_invalid");
  const paths = Buffer.from(result.stdout ?? []).toString("utf8").split("\0").filter(Boolean);
  for (const candidateMigration of candidateMigrations) if (existsSync(resolve(root, candidateMigration)) && !paths.includes(candidateMigration)) paths.push(candidateMigration);
  paths.sort();
  if (!paths.includes("prisma/schema.prisma") || !paths.includes("prisma/migrations/migration_lock.toml") || paths.some((path) => !path.startsWith("prisma/") || (!path.endsWith("migration.sql") && path !== "prisma/schema.prisma" && path !== "prisma/migrations/migration_lock.toml"))) {
    throw new Error("p1_3_phase1_tracked_prisma_inventory_invalid");
  }
  for (const path of paths) {
    const target = resolve(destination, path.slice("prisma/".length));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(root, path), target);
  }
}

export async function runP13GlobalSecurityPhase1Acceptance() {
  const suffix = randomBytes(8).toString("hex");
  const project = `cubby-p1-3-phase1-acceptance-${suffix}`;
  const user = `p13_phase1_${suffix}`;
  const database = `p13_phase1_${suffix}`;
  const rollbackDatabase = `p13_rollback_${suffix}`;
  const password = randomBytes(24).toString("base64url");
  const runtimePassword = randomBytes(24).toString("base64url");
  const authPassword = randomBytes(24).toString("base64url");
  const deliveryPassword = randomBytes(24).toString("base64url");
  const operatorPassword = randomBytes(24).toString("base64url");
  const throttleKey = randomBytes(32).toString("base64url");
  mkdirSync(workerRuntime, { recursive: true });
  const temporaryRoot = mkdtempSync(resolve(workerRuntime, "cubby-p1-3-phase1-"));
  const copiedPrisma = resolve(temporaryRoot, "prisma");
  const rollbackPrisma = resolve(temporaryRoot, "rollback-prisma");
  const env = acceptanceEnv(user, database, password);
  env.CUBBY_RUNTIME_DB_PASSWORD = runtimePassword;
  env.CUBBY_AUTH_DB_PASSWORD = authPassword;
  env.CUBBY_SECURITY_OPERATOR_DB_PASSWORD = operatorPassword;
  const compose = ["compose", "--project-name", project, "--file", composeFile];
  const psql = (statement: string, targetDatabase = database) => [
    ...compose,
    "exec", "-T", "postgres", "env", `PGPASSWORD=${password}`,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-U", user, "-d", targetDatabase, "-c", canonicalizeGlobalSecurityFixtureIds(statement)
  ];
  const runtimePsql = (statement: string) => [
    ...compose,
    "exec", "-T", "postgres", "env", `PGPASSWORD=${runtimePassword}`,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-U", "cubby_runtime", "-d", database, "-c", canonicalizeGlobalSecurityFixtureIds(statement)
  ];
  const deliveryPsql = (statement: string) => [
    ...compose,
    "exec", "-T", "postgres", "env", `PGPASSWORD=${deliveryPassword}`,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-U", "cubby_email_delivery", "-d", database, "-c", canonicalizeGlobalSecurityFixtureIds(statement)
  ];
  const authPsql = (statement: string) => [
    ...compose,
    "exec", "-T", "postgres", "env", `PGPASSWORD=${authPassword}`,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-U", "cubby_auth", "-d", database, "-c", canonicalizeGlobalSecurityFixtureIds(statement)
  ];
  const operatorPsql = (statement: string) => [
    ...compose,
    "exec", "-T", "postgres", "env", `PGPASSWORD=${operatorPassword}`,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-U", "cubby_security_operator", "-d", database, "-c", canonicalizeGlobalSecurityFixtureIds(statement)
  ];
  const sql = (statement: string, expected?: string) => {
    const output = run("docker", psql(statement), env, true, "p1_3_phase1_acceptance_sql_failed");
    if (expected !== undefined && output !== expected) {
      process.stderr.write(`unexpected_sql_result=${JSON.stringify(output)}\n`);
      throw new Error("p1_3_phase1_acceptance_sql_assertion_failed");
    }
    return output;
  };
  const rejectSql = (statement: string, expectedMarker: string) => {
    const result = spawnSync("docker", psql(statement), { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const diagnostic = redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, env);
    if (result.error || result.status === 0 || !diagnostic.includes(expectedMarker)) {
      process.stderr.write(diagnostic.slice(-12_000));
      throw new Error(`p1_3_phase1_expected_rejection_missing:${expectedMarker}`);
    }
  };
  const runtimeSql = (statement: string, expected?: string) => {
    const output = run("docker", runtimePsql(statement), env, true, "p1_3_phase1_runtime_sql_failed");
    if (expected !== undefined && output !== expected) throw new Error("p1_3_phase1_runtime_sql_assertion_failed");
    return output;
  };
  const rejectRuntimeSql = (statement: string, expectedMarker: string) => {
    const result = spawnSync("docker", runtimePsql(statement), { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const diagnostic = redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, env);
    if (result.error || result.status === 0 || !diagnostic.includes(expectedMarker)) throw new Error(`p1_3_phase1_runtime_rejection_missing:${expectedMarker}`);
  };
  const deliverySql = (statement: string, expected?: string) => {
    const output = run("docker", deliveryPsql(statement), env, true, "p1_3_phase1_delivery_sql_failed");
    if (expected !== undefined && output !== expected) throw new Error("p1_3_phase1_delivery_sql_assertion_failed");
    return output;
  };
  const authSql = (statement: string, expected?: string) => {
    const output = run("docker", authPsql(statement), env, true, "p1_3_phase7_auth_sql_failed");
    if (expected !== undefined && output !== expected) throw new Error("p1_3_phase7_auth_sql_assertion_failed");
    return output;
  };
  const rejectAuthSql = (statement: string, expectedMarker: string) => {
    const result = spawnSync("docker", authPsql(statement), { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const diagnostic = redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, env);
    if (result.error || result.status === 0 || !diagnostic.includes(expectedMarker)) throw new Error(`p1_3_phase7_auth_rejection_missing:${expectedMarker}`);
  };
  const operatorSql = (statement: string, expected?: string) => {
    const output = run("docker", operatorPsql(statement), env, true, "p1_3_phase8_operator_sql_failed");
    if (expected !== undefined && output !== expected) throw new Error("p1_3_phase8_operator_sql_assertion_failed");
    return output;
  };
  const rejectOperatorSql = (statement: string, expectedMarker: string) => {
    const result = spawnSync("docker", operatorPsql(statement), { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const diagnostic = redact(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, env);
    if (result.error || result.status === 0 || !diagnostic.includes(expectedMarker)) throw new Error(`p1_3_phase8_operator_rejection_missing:${expectedMarker}`);
  };
  const rejectRecoveryCarrier = (caseName: string, statement: string, expectedMarker: string) => {
    if (!caseName.startsWith("recovery_carrier_") && caseName !== "ordinary_session_recovery_reset") {
      throw new Error("p1_3_phase1_recovery_carrier_case_name_invalid");
    }
    rejectSql(statement, expectedMarker);
  };
  const startSql = (statement: string) => {
    const child = spawn("docker", psql(statement), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const done = new Promise<{ status: number | null; output: string }>((resolveDone, rejectDone) => {
      child.once("error", rejectDone);
      child.once("close", (status) => resolveDone({ status, output: redact(output, env) }));
    });
    const waitFor = (marker: string) => new Promise<void>((resolveMarker, rejectMarker) => {
      if (output.includes(marker)) return resolveMarker();
      const timeout = setTimeout(() => rejectMarker(new Error(`p1_3_phase1_sql_marker_timeout:${marker}`)), 10_000);
      const onData = () => {
        if (!output.includes(marker)) return;
        clearTimeout(timeout);
        child.stdout.off("data", onData);
        resolveMarker();
      };
      child.stdout.on("data", onData);
    });
    return { done, waitFor, output: () => output };
  };
  const observeTransitionWait = async (name: string, statement: string, expectedFailure?: string) => {
    const controllerMarker = `${name}_controller_probe`;
    const contenderMarker = `${name}_contender_probe`;
    const controller = startSql(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0)); SELECT pg_sleep(5) /* ${controllerMarker} */; COMMIT;`);
    let controllerPid = "";
    for (let attempt = 0; attempt < 40 && !controllerPid; attempt += 1) {
      controllerPid = run("docker", psql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%${controllerMarker}%' AND state='active' LIMIT 1`), env, true, `${name}_controller_probe_failed`);
      if (!controllerPid) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (!controllerPid) throw new Error(`${name}_controller_pid_missing`);
    const contender = startSql(`${statement} /* ${contenderMarker} */`);
    let contenderPid = "";
    for (let attempt = 0; attempt < 40 && !contenderPid; attempt += 1) {
      contenderPid = run("docker", psql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%${contenderMarker}%' AND state='active' LIMIT 1`), env, true, `${name}_contender_probe_failed`);
      if (!contenderPid) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (!contenderPid) throw new Error(`${name}_contender_pid_missing`);
    let waited = false;
    for (let attempt = 0; attempt < 40 && !waited; attempt += 1) {
      waited = run("docker", psql(`SELECT ${controllerPid}::integer = ANY(pg_blocking_pids(${contenderPid}::integer))`), env, true, `${name}_wait_probe_failed`) === "t";
      if (!waited) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (!waited) throw new Error(`${name}_wait_not_observed`);
    const [controllerResult, contenderResult] = await Promise.all([controller.done, contender.done]);
    if (controllerResult.status !== 0) throw new Error(`${name}_controller_failed`);
    if (expectedFailure ? contenderResult.status === 0 || !contenderResult.output.includes(expectedFailure) : contenderResult.status !== 0) {
      process.stderr.write(contenderResult.output.slice(-12_000));
      throw new Error(`${name}_contender_outcome_invalid`);
    }
    console.log(`${name}_transition_wait_observed`);
  };
  const resourceCount = (kind: "ps" | "volume" | "network") => {
    const filter = `label=com.docker.compose.project=${project}`;
    const args = kind === "ps"
      ? ["ps", "--all", "--quiet", "--filter", filter]
      : [kind, "ls", "--quiet", "--filter", filter];
    return run("docker", args, env, true, "p1_3_phase1_cleanup_probe_failed").split(/\r?\n/).filter(Boolean).length;
  };

  const retainedTables = [
    "AccountSecurityState",
    "FreshAuthGrant",
    "RecoveryCodeSet",
    "RecoveryCode",
    "RecoverySession",
    "GlobalSecurityOperationBinding",
    "GlobalSecurityOperation",
    "GlobalSecurityOperationTombstone",
    "GlobalSecurityOperationReservationTombstone",
    "GlobalSecurityEvent",
    "GlobalSecurityIncident",
    "EmailChange",
    "SessionSecurityActivity"
  ];
  const deleteFixtures: Record<string, string> = {
    AccountSecurityState: '"userId"=\'u1\'',
    FreshAuthGrant: '"id"=\'grant-u1\'',
    RecoveryCodeSet: '"userId"=\'u1\' AND "setVersion"=1',
    RecoveryCode: '"id"=\'code-u1-1\'',
    RecoverySession: '"id"=\'recovery-session-u8\'',
    GlobalSecurityOperationBinding: '"id"=\'binding-email-u1\'',
    GlobalSecurityOperation: '"userId"=\'u1\' AND "operationId"=\'operation-email-u1\'',
    GlobalSecurityOperationTombstone: '"userId"=\'u1\' AND "operationId"=\'operation-terminal-u1\'',
    GlobalSecurityOperationReservationTombstone: '"userId"=\'u1\' AND "operationId"=\'operation-expired-u1\'',
    GlobalSecurityEvent: '"id"=\'event-u1\'',
    GlobalSecurityIncident: '"id"=\'incident-u1\'',
    EmailChange: '"id"=\'email-change-u1\'',
    SessionSecurityActivity: '"sessionId"=\'session-u1\''
  };
  const deleteMarkers: Record<string, string> = {
    AccountSecurityState: "account_security_state_delete_forbidden",
    FreshAuthGrant: "fresh_auth_grant_delete_forbidden",
    RecoveryCodeSet: "global_security_retention_delete_forbidden",
    RecoveryCode: "recovery_code_delete_forbidden",
    RecoverySession: "recovery_session_write_once",
    GlobalSecurityOperationBinding: "global_security_binding_write_once",
    GlobalSecurityOperation: "global_security_operation_write_once",
    GlobalSecurityOperationTombstone: "global_security_tombstone_write_once",
    GlobalSecurityOperationReservationTombstone: "global_security_tombstone_write_once",
    GlobalSecurityEvent: "global_security_event_append_only",
    GlobalSecurityIncident: "global_security_retention_delete_forbidden",
    EmailChange: "email_change_delete_forbidden",
    SessionSecurityActivity: "global_security_retention_delete_forbidden"
  };

  const seedEmailOperation = (id: string, grantTtl = "10 minutes", emailTtl = "1 hour") => {
    sql(`
      INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('session-${id}','token-${id}',NOW()+INTERVAL '1 day','${id}',NOW(),NOW());
      INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('${id}',1,1,NOW());
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-email-${id}','${id}','session-${id}','operation-email-${id}','email_change',1,'opening-email-${id}','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-email-${id}','${id}','operation-email-${id}','email_change','intent-email-${id}','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-email-${id}';
      INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('grant-${id}','${id}','session-${id}','operation-email-${id}','email_change',1,'issued',NOW()+INTERVAL '${grantTtl}',NOW());
      INSERT INTO "EmailChange" ("id","userId","operationId","freshAuthGrantId","securityVersion","normalizedNewEmail","verificationDigest","state","expiresAt","createdAt","updatedAt") VALUES ('email-change-${id}','${id}','operation-email-${id}','grant-${id}',1,'new-${id}@acceptance.invalid','digest-${id}','pending',NOW()+INTERVAL '${emailTtl}',NOW(),NOW());
    `);
  };
  const seedRecoverySet = (id: string) => sql(`
    BEGIN;
    INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('recovery-issue-session-${id}','recovery-issue-token-${id}',NOW()+INTERVAL '1 day','${id}',NOW(),NOW());
    INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","sessionSecurityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('recovery-issue-binding-${id}','${id}','recovery-issue-session-${id}','recovery-issue-operation-${id}','recovery_enrollment',1,1,'recovery-issue-opening-${id}','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
    INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('recovery-issue-binding-${id}','${id}','recovery-issue-operation-${id}','recovery_enrollment','recovery-issue-intent-${id}','pending',NOW(),NOW());
    UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='recovery-issue-binding-${id}';
    INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('recovery-issue-grant-${id}','${id}','recovery-issue-session-${id}','recovery-issue-operation-${id}','recovery_enrollment',1,'issued',NOW()+INTERVAL '10 minutes',NOW());
    INSERT INTO "RecoveryCodeSet" ("userId","setVersion","issuanceOperationId","freshAuthGrantId","issuanceSecurityVersion","issuanceSessionSecurityVersion","state","updatedAt") VALUES ('${id}',1,'recovery-issue-operation-${id}','recovery-issue-grant-${id}',1,1,'generated',NOW());
    INSERT INTO "RecoveryCode" ("id","userId","setVersion","ordinal","salt","derivedKey","state","createdAt")
    SELECT 'code-${id}-' || ordinal, '${id}', 1, ordinal, decode(lpad(to_hex(ordinal),32,'0'),'hex'), decode(lpad(to_hex(ordinal),64,'0'),'hex'), 'active', NOW()
    FROM generate_series(1,10) ordinal;
    UPDATE "FreshAuthGrant" SET "state"='consumed',"consumedAt"=NOW() WHERE "id"='recovery-issue-grant-${id}';
    COMMIT;
  `);
  const retireRecoveryIssuanceSession = (id: string) => sql(`DELETE FROM "Session" WHERE "id"='recovery-issue-session-${id}'`);
  const rehearseRecoverySet = (id: string) => sql(`
    BEGIN;
    INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('recovery-enroll-session-${id}','recovery-enroll-token-${id}',NOW()+INTERVAL '1 day','${id}',NOW(),NOW());
    INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('recovery-enroll-binding-${id}','${id}','recovery-enroll-session-${id}','recovery-enroll-operation-${id}','recovery_enrollment',1,'recovery-enroll-opening-${id}','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
    INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('recovery-enroll-binding-${id}','${id}','recovery-enroll-operation-${id}','recovery_enrollment','recovery-enroll-intent-${id}','pending',NOW(),NOW());
    UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='recovery-enroll-binding-${id}';
    UPDATE "RecoveryCodeSet" SET "state"='save_acknowledged',"saveAcknowledgedAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='${id}' AND "setVersion"=1;
    UPDATE "RecoveryCodeSet" SET "state"='rehearsal_required',"updatedAt"=NOW() WHERE "userId"='${id}' AND "setVersion"=1;
    UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='enrollment_rehearsal',"consumedOperationId"='recovery-enroll-operation-${id}',"consumedAt"=NOW() WHERE "id"='code-${id}-1';
    UPDATE "RecoveryCodeSet" SET "state"='rehearsed',"rehearsedAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='${id}' AND "setVersion"=1;
    COMMIT;
  `);
  const retireRecoveryEnrollmentSession = (id: string) => sql(`DELETE FROM "Session" WHERE "id"='recovery-enroll-session-${id}'`);

  copyTrackedPrisma(copiedPrisma, env);
  cpSync(copiedPrisma, rollbackPrisma, { recursive: true });
  const rollbackMigrationPath = resolve(rollbackPrisma, "migrations/20260824140000_global_security_foundation/migration.sql");
  const rollbackMigration = readFileSync(rollbackMigrationPath, "utf8").replace(
    /\nCOMMIT;\s*$/,
    () => "\nDO $$ BEGIN RAISE EXCEPTION 'p1_3_phase1_injected_migration_failure'; END $$;\nCOMMIT;\n"
  );
  if (!rollbackMigration.includes("DO $$ BEGIN RAISE EXCEPTION 'p1_3_phase1_injected_migration_failure'; END $$;")) throw new Error("p1_3_phase1_injected_migration_fixture_invalid");
  writeFileSync(rollbackMigrationPath, rollbackMigration, "utf8");
  try {
    run("docker", [...compose, "up", "--detach", "--wait", "postgres"], env, true, "p1_3_phase1_postgres_start_failed");
    const published = run("docker", [...compose, "port", "postgres", "5432"], env, true, "p1_3_phase1_port_probe_failed");
    if (!/^127\.0\.0\.1:\d+$/.test(published)) throw new Error("p1_3_phase1_loopback_port_invalid");
    const databaseUrlFor = (targetDatabase: string) => {
      const url = new URL(`postgresql://${encodeURIComponent(user)}@${published}/${targetDatabase}`);
      url.password = password;
      url.searchParams.set("schema", "public");
      return url.toString();
    };
    const databaseUrl = databaseUrlFor(database);
    const rollbackDatabaseUrl = databaseUrlFor(rollbackDatabase);
    const runtimeDatabaseUrl = new URL(databaseUrl);
    runtimeDatabaseUrl.username = "cubby_runtime";
    runtimeDatabaseUrl.password = runtimePassword;
    const authDatabaseUrl = new URL(databaseUrl);
    authDatabaseUrl.username = "cubby_auth";
    authDatabaseUrl.password = authPassword;
    const deliveryDatabaseUrl = new URL(databaseUrl);
    deliveryDatabaseUrl.username = "cubby_email_delivery";
    deliveryDatabaseUrl.password = deliveryPassword;
    const operatorDatabaseUrl = new URL(databaseUrl);
    operatorDatabaseUrl.username = "cubby_security_operator";
    operatorDatabaseUrl.password = operatorPassword;
    const prismaCli = resolve(root, "node_modules/prisma/build/index.js");
    run("docker", [...compose, "exec", "-T", "postgres", "env", `PGPASSWORD=${password}`, "createdb", "-U", user, rollbackDatabase], env, true, "p1_3_phase1_rollback_database_create_failed");
    const rollbackResult = spawnSync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", resolve(rollbackPrisma, "schema.prisma")], {
      cwd: temporaryRoot,
      env: { ...env, DATABASE_URL: rollbackDatabaseUrl },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const rollbackDiagnostic = redact(`${rollbackResult.stdout ?? ""}\n${rollbackResult.stderr ?? ""}`, env);
    if (rollbackResult.error || rollbackResult.status === 0) {
      process.stderr.write(rollbackDiagnostic.slice(-12_000));
      throw new Error("p1_3_phase1_injected_migration_nonzero_not_observed");
    }
    const rollbackObjectCount = run("docker", psql(`
      SELECT
        (SELECT COUNT(*) FROM pg_type WHERE typname IN ('GlobalSecurityOperationKey','GlobalSecurityOperationStatus','FreshAuthGrantState','RecoveryCodeState','RecoveryCodeSetState','RecoveryCodeConsumptionPurpose','RecoverySessionState','EmailChangeState','GlobalSecurityIncidentState','SessionSecurityActivityState'))
        + (SELECT COUNT(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname ~ '^(AccountSecurityState|FreshAuthGrant|RecoveryCode|RecoverySession|GlobalSecurity|EmailChange|SessionSecurityActivity|Session_userId_id_key)')
        + (SELECT COUNT(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname ~ '(global_security|fresh_auth|recovery_code|recovery_session|email_change|session_security|account_security)')
        + (SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname ~ '(GlobalSecurity|FreshAuth|RecoveryCode|RecoverySession|EmailChange|SessionSecurity|AccountSecurity)')
        + (SELECT COUNT(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname ~ '^(AccountSecurityState|FreshAuthGrant|RecoveryCode|RecoverySession|GlobalSecurity|EmailChange|SessionSecurityActivity)')
    `, rollbackDatabase), env, true, "p1_3_phase1_rollback_probe_failed");
    if (rollbackObjectCount !== "0") throw new Error(`p1_3_phase1_rollback_left_objects:${rollbackObjectCount}`);
    run("docker", [...compose, "exec", "-T", "postgres", "env", `PGPASSWORD=${password}`, "dropdb", "-U", user, rollbackDatabase], env, true, "p1_3_phase1_rollback_database_drop_failed");
    console.log("P1_3_GLOBAL_SECURITY_PHASE1_ROLLBACK_PASS");
    run(process.execPath, [resolve(root, "scripts/provision-security-runtime-role.mjs")], { ...env, DATABASE_URL: databaseUrl, CUBBY_RUNTIME_DATABASE_URL: runtimeDatabaseUrl.toString(), CUBBY_AUTH_DATABASE_URL: authDatabaseUrl.toString(), CUBBY_EMAIL_DELIVERY_DATABASE_URL: deliveryDatabaseUrl.toString() }, true, "p1_3_phase1_runtime_role_provision_failed");
    run(process.execPath, [prismaCli, "migrate", "deploy", "--schema", resolve(copiedPrisma, "schema.prisma")], { ...env, DATABASE_URL: databaseUrl }, true, "p1_3_phase1_migrate_deploy_failed", temporaryRoot);
    run(process.execPath, [resolve(root, "scripts/provision-global-security-throttle-key.mjs")], { ...env, DATABASE_URL: databaseUrl, CUBBY_THROTTLE_KEY: throttleKey }, true, "p1_3_phase8_throttle_key_provision_failed");
    runtimeEnv.CUBBY_THROTTLE_KEY = throttleKey;
    run(process.execPath, [resolve(root, "scripts/provision-fresh-auth-attestation-keys.mjs")], { ...env, DATABASE_URL: databaseUrl, CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${Buffer.alloc(32, 0x11).toString("base64url")}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" }, true, "p1_3_phase1_attestation_key_provision_failed");
    const emailDeliveryKeyring = `1:${Buffer.alloc(32, 0x33).toString("base64url")}`;
    run(process.execPath, [resolve(root, "scripts/provision-email-delivery-keys.mjs")], { ...env, DATABASE_URL: databaseUrl, CUBBY_EMAIL_DELIVERY_KEYRING: emailDeliveryKeyring, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" }, true, "p1_3_phase6_delivery_key_provision_failed");
    sql(`SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname='cubby_runtime'`, "t");
    sql(`SELECT (SELECT COUNT(*) FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE member.rolname='cubby_runtime') || '|' || (SELECT COUNT(*) FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE granted.rolname='cubby_runtime')`, "0|0");
    sql(`SELECT COUNT(*) FROM (SELECT 1 FROM pg_class WHERE relowner='cubby_runtime'::regrole UNION ALL SELECT 1 FROM pg_proc WHERE proowner='cubby_runtime'::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner='cubby_runtime'::regrole UNION ALL SELECT 1 FROM pg_database WHERE datdba='cubby_runtime'::regrole) ownership`, "0");
    sql(`SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname='cubby_auth'`, "t");
    sql(`SELECT (SELECT COUNT(*) FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE member.rolname='cubby_auth') || '|' || (SELECT COUNT(*) FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE granted.rolname='cubby_auth')`, "0|0");
    sql(`SELECT COUNT(*) FROM (SELECT 1 FROM pg_class WHERE relowner='cubby_auth'::regrole UNION ALL SELECT 1 FROM pg_proc WHERE proowner='cubby_auth'::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner='cubby_auth'::regrole UNION ALL SELECT 1 FROM pg_database WHERE datdba='cubby_auth'::regrole) ownership`, "0");
    sql(`SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname='cubby_email_delivery'`, "t");
    authSql(`SELECT string_agg(table_name || ':' || privilege_type,',' ORDER BY table_name,privilege_type) FROM information_schema.role_table_grants WHERE grantee=current_user AND table_schema='public'`, "Account:SELECT,Session:DELETE,Session:INSERT,Session:SELECT,Session:UPDATE,User:SELECT,Verification:SELECT");
    rejectAuthSql(`SELECT * FROM "AccountSecurityState" LIMIT 1`, "permission denied");
    rejectAuthSql(`INSERT INTO "Account" ("id","accountId","providerId","userId","createdAt","updatedAt") VALUES ('phase7-forged-account','phase7-forged','credential','missing',NOW(),NOW())`, "permission denied");
    console.log("phase7_auth_role_least_privilege_pass");
    runtimeSql(`SELECT has_table_privilege(current_user,'"Session"','INSERT,UPDATE,DELETE') || '|' || has_table_privilege(current_user,'"SessionSecurityActivity"','INSERT,UPDATE,DELETE') || '|' || has_function_privilege(current_user,'initialize_global_session_security_activity(text,text)','EXECUTE') || '|' || has_function_privilege(current_user,'authorize_global_session_security(text,text,text)','EXECUTE')`, "false|false|true|true");
    rejectRuntimeSql(`UPDATE "Session" SET "updatedAt"=NOW() WHERE false`, "permission denied");
    rejectRuntimeSql(`DELETE FROM "SessionSecurityActivity" WHERE false`, "permission denied");
    console.log("phase7_runtime_session_dml_denied");
    runtimeSql(`SELECT has_function_privilege(current_user,'claim_email_change_delivery(text)','EXECUTE')`, "f");
    deliverySql(`SELECT has_function_privilege(current_user,'claim_email_change_delivery(text)','EXECUTE') || '|' || has_table_privilege(current_user,'\"EmailChangeDelivery\"','SELECT')`, "true|false");
    runtimeSql(`SELECT has_table_privilege(current_user,'"FreshAuthAttestationKey"','SELECT') || '|' || has_function_privilege(current_user,'verify_password_fresh_auth_attestation(text,text,text,text,integer,integer,text,text,bytea,text,integer,bytea)','EXECUTE')`, "false|false");

    // Phase 8 uses only generated loopback credentials.  It exercises the
    // runtime-facing services, while owner SQL is limited to fixture inspection.
    sql(`SELECT encode("keyDigest",'hex') <> '' AND "verifiedAt">="createdAt" FROM "GlobalSecurityThrottleKey" WHERE "singletonId"=1`, "t");
    sql(`SELECT rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname='cubby_security_operator'`, "t");
    sql(`SELECT (SELECT COUNT(*) FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE member.rolname='cubby_security_operator') || '|' || (SELECT COUNT(*) FROM pg_auth_members membership JOIN pg_roles granted ON granted.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE granted.rolname='cubby_security_operator')`, "0|0");
    sql(`SELECT COUNT(*) FROM (SELECT 1 FROM pg_class WHERE relowner='cubby_security_operator'::regrole UNION ALL SELECT 1 FROM pg_proc WHERE proowner='cubby_security_operator'::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner='cubby_security_operator'::regrole UNION ALL SELECT 1 FROM pg_database WHERE datdba='cubby_security_operator'::regrole) ownership`, "0");
    runtimeSql(`SELECT has_table_privilege(current_user,'"GlobalSecurityEvent"','SELECT,INSERT,UPDATE,DELETE') || '|' || has_table_privilege(current_user,'"GlobalSecurityIncident"','SELECT,INSERT,UPDATE,DELETE') || '|' || has_table_privilege(current_user,'"GlobalSecurityThrottleKey"','SELECT,INSERT,UPDATE,DELETE') || '|' || has_function_privilege(current_user,'global_security_throttle_precheck(text,text,text,text)','EXECUTE') || '|' || has_function_privilege(current_user,'global_security_throttle_failure(text,text,text,text)','EXECUTE') || '|' || has_function_privilege(current_user,'write_global_security_event(text,text,text,text)','EXECUTE') || '|' || has_function_privilege(current_user,'read_global_security_history(text,text,integer,integer,bigint,bigint,integer,boolean)','EXECUTE') || '|' || has_function_privilege(current_user,'read_global_security_operator_aggregate(date,date)','EXECUTE')`, "false|false|false|true|true|true|true|false");
    for (const table of ["GlobalSecurityEvent", "GlobalSecurityIncident", "GlobalSecurityThrottleKey"]) {
      rejectRuntimeSql(`SELECT * FROM "${table}" LIMIT 1`, "permission denied");
      rejectRuntimeSql(`INSERT INTO "${table}" DEFAULT VALUES`, "permission denied");
      rejectRuntimeSql(`UPDATE "${table}" SET "createdAt"=NOW() WHERE false`, "permission denied");
      rejectRuntimeSql(`DELETE FROM "${table}" WHERE false`, "permission denied");
    }
    operatorSql(`SELECT has_table_privilege(current_user,'"GlobalSecurityEvent"','SELECT,INSERT,UPDATE,DELETE') || '|' || has_table_privilege(current_user,'"GlobalSecurityIncident"','SELECT,INSERT,UPDATE,DELETE') || '|' || has_table_privilege(current_user,'"GlobalSecurityThrottleKey"','SELECT,INSERT,UPDATE,DELETE') || '|' || has_function_privilege(current_user,'read_global_security_operator_aggregate(date,date)','EXECUTE') || '|' || has_function_privilege(current_user,'global_security_throttle_precheck(text,text,text,text)','EXECUTE') || '|' || has_function_privilege(current_user,'read_global_security_history(text,text,integer,integer,bigint,bigint,integer,boolean)','EXECUTE')`, "false|false|false|true|false|false");
    rejectOperatorSql(`SELECT * FROM "GlobalSecurityIncident" LIMIT 1`, "permission denied");
    rejectOperatorSql(`SELECT * FROM "read_global_security_history"('x','x',1,1,NULL,NULL,1,false)`, "permission denied");
    console.log("PHASE8_ROLE_AND_EXACT_GRANT_PASS");

    const phase8Database = new PrismaClient({ datasourceUrl: runtimeDatabaseUrl.toString() });
    const phase8AuthDatabase = new PrismaClient({ datasourceUrl: authDatabaseUrl.toString() });
    const phase8User = `phase8-${suffix}-user`;
    const phase8OtherUser = `phase8-${suffix}-other-user`;
    const phase8Session = `phase8-${suffix}-session`;
    const phase8OtherSession = `phase8-${suffix}-other-session`;
      const phase8Context = { userId: phase8User, sessionId: phase8Session, credentialVersion: 1, sessionSecurityVersion: 1 };
      const expectHistoryCursorRejection = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          if (error instanceof Error && error.message === "security_history_cursor_invalid") return;
        }
        throw new Error("phase8_history_cursor_rejection_missing");
      };
    try {
      sql(`INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('${phase8User}','Phase Eight Fixture','phase8-${suffix}@acceptance.invalid',true,NOW(),NOW()),('${phase8OtherUser}','Phase Eight Other','phase8-other-${suffix}@acceptance.invalid',true,NOW(),NOW()); INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('${phase8User}',1,1,NOW()),('${phase8OtherUser}',1,1,NOW())`);
      await phase8AuthDatabase.session.createMany({ data: [
        { id: phase8Session, token: randomBytes(32).toString("base64url"), userId: phase8User, expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(), updatedAt: new Date() },
        { id: phase8OtherSession, token: randomBytes(32).toString("base64url"), userId: phase8OtherUser, expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(), updatedAt: new Date() }
      ] });
      sql(`SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "eventType"='credential' AND "outcome"='sign_in_succeeded' AND "userId" IN ('${phase8User}','${phase8OtherUser}')`, "2");
      authSql(`BEGIN; INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('phase8-signin-rollback-${suffix}','phase8-signin-rollback-token-${suffix}',NOW()+INTERVAL '1 day','${phase8User}',NOW(),NOW()); ROLLBACK`);
      sql(`SELECT (SELECT COUNT(*) FROM "Session" WHERE "id"='phase8-signin-rollback-${suffix}') || '|' || (SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8User}' AND "eventType"='credential' AND "outcome"='sign_in_succeeded')`, "0|1");
      sql(`CREATE FUNCTION "phase8_acceptance_reject_event"() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'phase8_acceptance_event_failure'; END $$; CREATE TRIGGER "99_phase8_acceptance_reject_event" BEFORE INSERT ON "GlobalSecurityEvent" FOR EACH ROW EXECUTE FUNCTION "phase8_acceptance_reject_event"()`);
      rejectAuthSql(`INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('phase8-signin-event-failure-${suffix}','phase8-signin-event-failure-token-${suffix}',NOW()+INTERVAL '1 day','${phase8User}',NOW(),NOW())`, "phase8_acceptance_event_failure");
      sql(`DROP TRIGGER "99_phase8_acceptance_reject_event" ON "GlobalSecurityEvent"; DROP FUNCTION "phase8_acceptance_reject_event"(); SELECT (SELECT COUNT(*) FROM "Session" WHERE "id"='phase8-signin-event-failure-${suffix}') || '|' || (SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8User}' AND "eventType"='credential' AND "outcome"='sign_in_succeeded')`, "DROP TRIGGER\nDROP FUNCTION\n0|1");
      const rollbackAccountKey = Buffer.alloc(32,0x61).toString("base64url");
      const rollbackClientKey = Buffer.alloc(32,0x62).toString("base64url");
      const rollbackDeploymentKey = Buffer.alloc(32,0x63).toString("base64url");
      runtimeSql(`BEGIN; SELECT * FROM "global_security_throttle_failure"('${phase8OtherUser}','${rollbackAccountKey}','${rollbackClientKey}','${rollbackDeploymentKey}'); SELECT "write_global_security_event"('${phase8OtherUser}','credential','sign_in_failed',NULL); ROLLBACK`);
      sql(`SELECT (SELECT COUNT(*) FROM "GlobalSecurityIncident" WHERE "normalizedKey" IN ('${rollbackAccountKey}','${rollbackClientKey}','${rollbackDeploymentKey}')) || '|' || (SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8OtherUser}' AND "eventType"='credential' AND "outcome"='sign_in_failed')`, "0|0");
      const carrierIncidentBefore = Number(sql(`SELECT COUNT(*) FROM "GlobalSecurityIncident"`));
      const carrierFailureEventBefore = Number(sql(`SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8OtherUser}' AND "eventType"='credential' AND "outcome"='sign_in_failed'`));
      const carrierKey = randomBytes(32).toString("base64url");
      const carrierRequest = (email: string) => new Request("http://127.0.0.1/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "[REDACTED]" }) });
      const carrierDependencies = (key: string, rollback: boolean) => ({
        throttleKey: key,
        trustedProxyHops: 0,
        findUserIdByNormalizedEmail: async () => phase8OtherUser,
        precheck: (input: Parameters<typeof precheckGlobalSecurityThrottle>[1]) => precheckGlobalSecurityThrottle(phase8Database,input),
        recordFailure: (input: Parameters<typeof recordGlobalSecurityThrottleFailure>[1],eventUserId: string | undefined) => phase8Database.$transaction(async (tx) => {
          const result = await recordGlobalSecurityThrottleFailureInTransaction(tx,input);
          if (eventUserId) await writeGlobalSecurityEvent(tx,eventUserId,"credential","sign_in_failed");
          if (rollback) throw new Error("synthetic_atomic_evidence_rollback");
          return result;
        },{isolationLevel:"Serializable"}),
        invoke: async () => new Response(JSON.stringify({code:"INVALID_EMAIL_OR_PASSWORD"}),{status:401,headers:{"content-type":"application/json"}})
      });
      const committedCarrierResponse = await runEmailSignInThrottleCarrier(carrierRequest(`phase8-other-${suffix}@acceptance.invalid`),carrierDependencies(carrierKey,false));
      if (committedCarrierResponse.status !== 401) throw new Error("phase8_sign_in_failure_carrier_status_invalid");
      sql(`SELECT (SELECT COUNT(*) FROM "GlobalSecurityIncident") || '|' || (SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8OtherUser}' AND "eventType"='credential' AND "outcome"='sign_in_failed')`, `${carrierIncidentBefore+3}|${carrierFailureEventBefore+1}`);
      const rollbackCarrierIncidentBefore = Number(sql(`SELECT COUNT(*) FROM "GlobalSecurityIncident"`));
      const rollbackCarrierEventBefore = Number(sql(`SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8OtherUser}' AND "eventType"='credential' AND "outcome"='sign_in_failed'`));
      const rollbackCarrierResponse = await runEmailSignInThrottleCarrier(carrierRequest(`phase8-other-${suffix}@acceptance.invalid`),carrierDependencies(randomBytes(32).toString("base64url"),true));
      if (rollbackCarrierResponse.status !== 503 || rollbackCarrierResponse.headers.has("retry-after")) throw new Error("phase8_sign_in_failure_evidence_unavailable_not_neutral");
      sql(`SELECT (SELECT COUNT(*) FROM "GlobalSecurityIncident") || '|' || (SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8OtherUser}' AND "eventType"='credential' AND "outcome"='sign_in_failed')`, `${rollbackCarrierIncidentBefore}|${rollbackCarrierEventBefore}`);
      await initializeGlobalSessionSecurityActivity(phase8Database, { userId: phase8User, sessionId: phase8Session });
      await initializeGlobalSessionSecurityActivity(phase8Database, { userId: phase8OtherUser, sessionId: phase8OtherSession });
      const throttleInput = { key: throttleKey, userId: phase8User, accountIdentifier: `phase8-${suffix}@acceptance.invalid`, client: "198.51.100.208" };
      const absentInput = { key: throttleKey, client: "198.51.100.209" };
      if ((await precheckGlobalSecurityThrottle(phase8Database, throttleInput)).quiet || (await precheckGlobalSecurityThrottle(phase8Database, absentInput)).quiet) throw new Error("phase8_existing_nonexisting_precheck_invalid");
      runtimeSql(`SELECT COUNT(*) FROM "read_global_security_history"('${phase8User}','${phase8Session}',1,1,NULL,NULL,100001,false)`, "1");
      rejectRuntimeSql(`SELECT * FROM "read_global_security_history"('${phase8User}','${phase8Session}',1,1,NULL,NULL,100002,false)`, "global_security_history_limit_invalid");
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        if ((await recordGlobalSecurityThrottleFailure(phase8Database, throttleInput)).quiet) throw new Error("phase8_active_attempt_quiet_early");
        sql(`SELECT string_agg("layer" || ':' || "state" || ':' || "failureCount",',' ORDER BY "layer") FROM (SELECT "layer","state","failureCount" FROM "GlobalSecurityIncident" WHERE "userId"='${phase8User}' OR "userId" IS NULL ORDER BY "createdAt" DESC LIMIT 3) scoped`, `account_identifier:active:${attempt},client:active:${attempt},deployment:active:${attempt}`);
      }
      const fifth = await Promise.all([recordGlobalSecurityThrottleFailure(phase8Database, throttleInput), recordGlobalSecurityThrottleFailure(phase8Database, throttleInput)]);
      if (!fifth.every((result) => result.quiet)) throw new Error("phase8_concurrent_fifth_not_quiet");
      sql(`SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8User}' AND "eventType"='throttle' AND "outcome"='quiet_started'`, "1");
      const quietBefore = sql(`SELECT "quietUntil"::text || '|' || "failureCount" FROM "GlobalSecurityIncident" WHERE "userId"='${phase8User}' AND "layer"='account_identifier'`);
      await recordGlobalSecurityThrottleFailure(phase8Database, throttleInput);
      const quietAfter = sql(`SELECT "quietUntil"::text || '|' || "failureCount" FROM "GlobalSecurityIncident" WHERE "userId"='${phase8User}' AND "layer"='account_identifier'`);
      if (quietBefore.split("|")[0] !== quietAfter.split("|")[0] || Number(quietAfter.split("|")[1]) !== Number(quietBefore.split("|")[1]) + 1) throw new Error("phase8_quiet_nonextension_invalid");
      sql(`ALTER TABLE "GlobalSecurityIncident" DISABLE TRIGGER "GlobalSecurityIncident_state_guard"; UPDATE "GlobalSecurityIncident" SET "quietUntil"=clock_timestamp() WHERE "state"='quiet'; ALTER TABLE "GlobalSecurityIncident" ENABLE TRIGGER "GlobalSecurityIncident_state_guard"`);
      if ((await precheckGlobalSecurityThrottle(phase8Database, throttleInput)).quiet) throw new Error("phase8_quiet_equality_expiry_invalid");
      sql(`SELECT "state" FROM "GlobalSecurityIncident" WHERE "userId"='${phase8User}' AND "layer"='account_identifier'`, "closed");
      const rolloverKey = randomBytes(32).toString("base64url");
      await recordGlobalSecurityThrottleFailure(phase8Database, { key: rolloverKey, client: "198.51.100.211" });
      sql(`ALTER TABLE "GlobalSecurityIncident" DISABLE TRIGGER "GlobalSecurityIncident_state_guard"; UPDATE "GlobalSecurityIncident" SET "windowStartedAt"=clock_timestamp()-INTERVAL '15 minutes' WHERE "id"=(SELECT "id" FROM "GlobalSecurityIncident" WHERE "userId" IS NULL AND "layer"='client' ORDER BY "createdAt" DESC LIMIT 1); ALTER TABLE "GlobalSecurityIncident" ENABLE TRIGGER "GlobalSecurityIncident_state_guard"`);
      await recordGlobalSecurityThrottleFailure(phase8Database, { key: rolloverKey, client: "198.51.100.211" });
      sql(`SELECT COUNT(*) FROM "GlobalSecurityIncident" WHERE "userId" IS NULL AND "layer"='client' AND "state"='active' AND "normalizedKey"=(SELECT "normalizedKey" FROM "GlobalSecurityIncident" WHERE "userId" IS NULL AND "layer"='client' ORDER BY "createdAt" DESC LIMIT 1)`, "1");
      const raceKey = randomBytes(32).toString("base64url");
      const race = await Promise.all([recordGlobalSecurityThrottleFailure(phase8Database, { key: raceKey, client: "198.51.100.210" }), recordGlobalSecurityThrottleFailure(phase8Database, { key: raceKey, client: "198.51.100.210" })]);
      if (race.some((result) => result.quiet)) throw new Error("phase8_unique_race_invalid");
      sql(`SELECT COUNT(*) FROM "GlobalSecurityIncident" WHERE "userId" IS NULL AND "normalizedKey" IN (SELECT "normalizedKey" FROM "GlobalSecurityIncident" WHERE "layer"='client' ORDER BY "createdAt" DESC LIMIT 1)`, "1");
      sql(`ALTER TABLE "GlobalSecurityIncident" DISABLE TRIGGER "GlobalSecurityIncident_state_guard"; UPDATE "GlobalSecurityIncident" SET "failureCount"=255 WHERE "userId"='${phase8User}' AND "layer"='account_identifier'; ALTER TABLE "GlobalSecurityIncident" ENABLE TRIGGER "GlobalSecurityIncident_state_guard"`);
      await recordGlobalSecurityThrottleFailure(phase8Database, throttleInput);
      sql(`SELECT "failureCount" FROM "GlobalSecurityIncident" WHERE "userId"='${phase8User}' AND "layer"='account_identifier'`, "255");
      await phase8Database.$transaction((tx) => writeGlobalSecurityEvent(tx, phase8User, "credential", "sign_in_succeeded"));
      sql(`SELECT COUNT(*) FROM "GlobalSecurityIncident" WHERE "userId"='${phase8User}' AND "state" IN ('active','quiet','closed')`, "1");
      console.log("PHASE8_THROTTLE_SERVICE_AND_PROCEDURE_PASS");

      for (const outcome of ["sign_in_failed", "sign_in_succeeded", "password_changed"] as const) await phase8Database.$transaction((tx) => writeGlobalSecurityEvent(tx, phase8User, "credential", outcome));
      const initialHistory = await listGlobalSecurityHistory(phase8Database, phase8Context, { limit: 2 });
      if (initialHistory.events.length !== 2 || initialHistory.events.some((event) => Object.keys(event).some((key) => ["userId", "eventId", "sequence", "normalizedKey", "safeProjection"].includes(key))) || !initialHistory.nextCursor) throw new Error("phase8_history_safe_projection_invalid");
      await phase8Database.$transaction((tx) => writeGlobalSecurityEvent(tx, phase8User, "grant", "current_password_failed"));
      const continuedHistory = await listGlobalSecurityHistory(phase8Database, phase8Context, { limit: 2, cursor: initialHistory.nextCursor });
      if (continuedHistory.events.some((event) => initialHistory.events.some((prior) => prior.handle === event.handle)) || continuedHistory.events.length !== 2) throw new Error("phase8_history_snapshot_keyset_invalid");
      await expectHistoryCursorRejection(() => listGlobalSecurityHistory(phase8Database, phase8Context, { cursor: "malformed" }));
      const otherContext = { userId: phase8OtherUser, sessionId: phase8OtherSession, credentialVersion: 1, sessionSecurityVersion: 1 };
      await expectHistoryCursorRejection(() => listGlobalSecurityHistory(phase8Database, otherContext, { cursor: initialHistory.nextCursor! }));
      const exportHistory = await exportGlobalSecurityHistory(phase8Database, phase8Context);
      const repeatedExport = await exportGlobalSecurityHistory(phase8Database, phase8Context);
      if (exportHistory.events.some((event) => Object.keys(event).some((key) => ["userId", "eventId", "sequence", "normalizedKey"].includes(key))) || exportHistory.events.length < 4 || new Set(exportHistory.events.map((event) => event.handle)).size !== exportHistory.events.length || exportHistory.events.map((event) => event.handle).join("|") !== repeatedExport.events.map((event) => event.handle).join("|")) throw new Error("phase8_history_export_projection_invalid");
      console.log("PHASE8_HISTORY_SERVICE_CURSOR_EXPORT_PASS");

      const snapshotBeforeRace = sql(`SELECT COALESCE(MAX("sequence"),0) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8User}'`);
      const sequenceBeforeRace = sql(`SELECT last_value FROM "GlobalSecurityEvent_sequence_seq"`);
      const snapshotControllerMarker = `phase8_event_snapshot_controller_${suffix}`;
      const snapshotContenderMarker = `phase8_event_snapshot_contender_${suffix}`;
      const snapshotController = startSql(`BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0)); SELECT COALESCE(MAX("snapshotMaxSequence"),0) FROM "read_global_security_history"('${phase8User}','${phase8Session}',1,1,NULL,NULL,100,false); SELECT COUNT(*) FROM "read_global_security_history"('${phase8User}','${phase8Session}',1,1,NULL,NULL,100001,true); SELECT pg_sleep(5) /* ${snapshotControllerMarker} */; COMMIT;`);
      let snapshotControllerPid = "";
      for (let attempt = 0; attempt < 80 && !snapshotControllerPid; attempt += 1) {
        snapshotControllerPid = sql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%${snapshotControllerMarker}%' AND state='active' LIMIT 1`);
        if (!snapshotControllerPid) await new Promise((resolveWait) => setTimeout(resolveWait,25));
      }
      if (!snapshotControllerPid) throw new Error("phase8_event_snapshot_controller_missing");
      const snapshotContenderEventId = `gse_snapshot_${suffix}`;
      const snapshotContender = startSql(`INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","incidentId","safeProjection","createdAt") VALUES ('${snapshotContenderEventId}','${phase8User}','credential','password_changed',NULL,NULL,'{}',clock_timestamp()) /* ${snapshotContenderMarker} */`);
      let snapshotContenderPid = "";
      for (let attempt = 0; attempt < 80 && !snapshotContenderPid; attempt += 1) {
        snapshotContenderPid = sql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%${snapshotContenderMarker}%' AND state='active' LIMIT 1`);
        if (!snapshotContenderPid) await new Promise((resolveWait) => setTimeout(resolveWait,25));
      }
      if (!snapshotContenderPid) throw new Error("phase8_event_snapshot_contender_missing");
      let snapshotWaitObserved = false;
      for (let attempt = 0; attempt < 80 && !snapshotWaitObserved; attempt += 1) {
        snapshotWaitObserved = sql(`SELECT ${snapshotControllerPid}::integer = ANY(pg_blocking_pids(${snapshotContenderPid}::integer))`) === "t";
        if (!snapshotWaitObserved) await new Promise((resolveWait) => setTimeout(resolveWait,25));
      }
      if (!snapshotWaitObserved || sql(`SELECT last_value FROM "GlobalSecurityEvent_sequence_seq"`) !== sequenceBeforeRace) throw new Error("phase8_event_sequence_allocated_before_snapshot_release");
      const [snapshotControllerResult,snapshotContenderResult] = await Promise.all([snapshotController.done,snapshotContender.done]);
      if (snapshotControllerResult.status !== 0 || snapshotContenderResult.status !== 0 || !snapshotControllerResult.output.includes(snapshotBeforeRace)) throw new Error("phase8_event_snapshot_race_outcome_invalid");
      sql(`SELECT "sequence">${snapshotBeforeRace}::bigint FROM "GlobalSecurityEvent" WHERE "id"='${snapshotContenderEventId}'`, "t");
      console.log("PHASE8_EVENT_SEQUENCE_SNAPSHOT_RACE_PASS");

      const exportCountBeforeRace = Number(sql(`SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8User}'`));
      const exportControllerMarker = `phase8_export_controller_${suffix}`;
      const exportController = startSql(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0)); SELECT pg_sleep(8) /* ${exportControllerMarker} */; COMMIT;`);
      let exportControllerPid = "";
      for (let attempt=0;attempt<80&&!exportControllerPid;attempt+=1) {
        exportControllerPid=sql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%${exportControllerMarker}%' AND state='active' LIMIT 1`);
        if(!exportControllerPid)await new Promise((resolveWait)=>setTimeout(resolveWait,25));
      }
      if(!exportControllerPid)throw new Error("phase8_export_controller_missing");
      const concurrentExportPromise=exportGlobalSecurityHistory(phase8Database,phase8Context);
      let exportReaderPid="";
      for(let attempt=0;attempt<120&&!exportReaderPid;attempt+=1){
        exportReaderPid=sql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND state='active' AND query LIKE '%read_global_security_history%' AND ${exportControllerPid}::integer=ANY(pg_blocking_pids(pid)) LIMIT 1`);
        if(!exportReaderPid)await new Promise((resolveWait)=>setTimeout(resolveWait,25));
      }
      if(!exportReaderPid)throw new Error("phase8_export_reader_wait_missing");
      const phase8ExportWriter=new PrismaClient({datasourceUrl:runtimeDatabaseUrl.toString()});
      let resolveExportWriterPid:(value:number)=>void=()=>undefined;
      const exportWriterPidPromise=new Promise<number>((resolvePid)=>{resolveExportWriterPid=resolvePid;});
      const exportWriterPromise=phase8ExportWriter.$transaction(async(tx)=>{
        const rows=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;
        resolveExportWriterPid(rows[0]!.pid);
        await writeGlobalSecurityEvent(tx,phase8User,"grant","current_password_failed");
      },{isolationLevel:"Serializable",maxWait:5_000,timeout:15_000});
      const exportWriterPid=await exportWriterPidPromise;
      let exportWriterWaitObserved=false;
      for(let attempt=0;attempt<120&&!exportWriterWaitObserved;attempt+=1){
        exportWriterWaitObserved=sql(`SELECT ${exportControllerPid}::integer=ANY(pg_blocking_pids(${exportWriterPid}::integer))`)==="t";
        if(!exportWriterWaitObserved)await new Promise((resolveWait)=>setTimeout(resolveWait,25));
      }
      if(!exportWriterWaitObserved)throw new Error("phase8_export_writer_wait_missing");
      const [exportControllerResult,concurrentExport]=await Promise.all([exportController.done,concurrentExportPromise,exportWriterPromise.then(()=>undefined)]).then(([controllerResult,exportResult])=>[controllerResult,exportResult] as const);
      await phase8ExportWriter.$disconnect();
      if(exportControllerResult.status!==0||concurrentExport.events.length!==exportCountBeforeRace)throw new Error("phase8_concurrent_export_snapshot_invalid");
      sql(`SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${phase8User}'`,String(exportCountBeforeRace+1));
      console.log("PHASE8_CONCURRENT_EXPORT_SNAPSHOT_PASS");
      console.log("PHASE8_SIGN_IN_SESSION_EVENT_ATOMICITY_PASS");
      console.log("PHASE8_SIGN_IN_FAILURE_INCIDENT_EVENT_ATOMICITY_PASS");

      run(process.execPath, [resolve(root, "node_modules/esbuild/bin/esbuild"), "scripts/security-operator.ts", "--bundle", "--platform=node", "--format=esm", "--target=node22", "--packages=external", "--outfile=dist/security-operator.mjs"], env, true, "phase8_operator_package_build_failed", root);
      const operatorFrom = sql(`SELECT current_date::text`);
      const operatorTo = new Date(`${operatorFrom}T00:00:00.000Z`);
      operatorTo.setUTCDate(operatorTo.getUTCDate() + 1);
      const aggregateOutput = run(process.execPath, [resolve(root, "dist/security-operator.mjs"), "aggregate", "--from", operatorFrom, "--to", operatorTo.toISOString().slice(0, 10)], { ...env, SECURITY_OPERATOR_DATABASE_URL: operatorDatabaseUrl.toString() }, true, "phase8_operator_packaged_cli_failed");
      const aggregate = JSON.parse(aggregateOutput) as { schemaVersion?: number; from?: string; to?: string; aggregates?: Array<Record<string, unknown>> };
      if (aggregate.schemaVersion !== 1 || aggregate.from !== operatorFrom || aggregate.to !== operatorTo.toISOString().slice(0, 10) || !aggregate.aggregates?.length || aggregate.aggregates.some((row) => Object.keys(row).sort().join("|") !== "coarseTimeBucket|incidentCount|layer|state")) throw new Error("phase8_operator_aggregate_projection_invalid");
      const operatorFailure = spawnSync(process.execPath, [resolve(root, "dist/security-operator.mjs"), "aggregate", "--from", operatorFrom, "--to", operatorTo.toISOString().slice(0, 10)], { cwd: root, env: { ...env, SECURITY_OPERATOR_DATABASE_URL: "postgresql://cubby_security_operator:generated@127.0.0.1:1/unavailable" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (operatorFailure.status !== 1 || operatorFailure.stdout || operatorFailure.stderr !== "security_operator_operation_failed\n" || operatorFailure.stderr.includes(operatorPassword)) throw new Error("phase8_operator_sanitized_failure_invalid");
      console.log("PHASE8_OPERATOR_PACKAGED_CLI_PASS");

      const retainedNeutralIncidentCount=sql(`SELECT COUNT(*) FROM "GlobalSecurityIncident" WHERE "userId" IS NULL`);
      sql(`SET cubby.global_security_account_deletion_user_id='["${phase8User}"]'; DELETE FROM "User" WHERE "id"='${phase8User}'; DELETE FROM "User" WHERE "id"='${phase8OtherUser}'`);
      sql(`SELECT (SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId" IN ('${phase8User}','${phase8OtherUser}')) || '|' || (SELECT COUNT(*) FROM "GlobalSecurityIncident" WHERE "userId" IS NULL)`, `0|${retainedNeutralIncidentCount}`);
      console.log("PHASE8_HISTORY_CASCADE_NEUTRAL_RETENTION_PASS");
    } finally {
      await phase8Database.$disconnect();
      await phase8AuthDatabase.$disconnect();
    }

    const phase7Database = new PrismaClient({ datasourceUrl: runtimeDatabaseUrl.toString() });
    const phase7AuthDatabase = new PrismaClient({ datasourceUrl: authDatabaseUrl.toString() });
    const phase7Signer = createFreshAuthAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${Buffer.alloc(32, 0x11).toString("base64url")}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" });
    const phase7Id = (label: string) => `phase7-${suffix}-${label}`;
    const phase7OperationId = (label: string) => {
      const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
      const digest = createHash("sha256").update(`${suffix}:${label}`).digest();
      return `gso_${Array.from(digest.subarray(0, 26), (byte) => alphabet[byte & 31]).join("")}`;
    };
    const phase7SeedUser = async (label: string, sessionLabels: string[]) => {
      const userId = phase7Id(`user-${label}`);
      sql(`INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('${userId}','Phase Seven Synthetic','${phase7Id(label)}@acceptance.invalid',true,NOW(),NOW()); INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('${userId}',1,1,NOW()); INSERT INTO "Account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('${phase7Id(`account-${label}`)}','${phase7Id(`credential-${label}`)}','credential','${userId}','phase7-synthetic-hash',NOW(),NOW())`);
      const sessionIds: string[] = [];
      for (const sessionLabel of sessionLabels) {
        const sessionId = phase7Id(`session-${label}-${sessionLabel}`);
        sessionIds.push(sessionId);
        await phase7AuthDatabase.session.create({ data: { id: sessionId, token: randomBytes(32).toString("base64url"), userId, expiresAt: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000), ipAddress: "192.0.2.7", userAgent: `Phase7/${sessionLabel}`, createdAt: new Date(), updatedAt: new Date() } });
        await initializeGlobalSessionSecurityActivity(phase7Database, { userId, sessionId });
      }
      return { userId, sessionIds };
    };
    const phase7Context = (userId: string, sessionId: string, sessionSecurityVersion = 1) => ({ userId, sessionId, credentialVersion: 1, sessionSecurityVersion });
    try {
      const listFixture = await phase7SeedUser("safe-list", ["current", "other"]);
      const listedSessions = await listGlobalSessionSecurity(phase7Database, { userId: listFixture.userId, sessionId: listFixture.sessionIds[0]! });
      if (listedSessions.length !== 2 || listedSessions.some((session) => Object.keys(session).sort().join("|") !== "createdAt|deviceLabel|expiresAt|handle|idleWarningAt|isCurrent|lastQualifyingAt")) throw new Error("phase7_safe_list_projection_invalid");
      console.log("phase7_safe_list_atomic_authorization_pass");
      const pendingFixture = await phase7SeedUser("status-pending", ["current", "target"]);
      const [pendingCurrent, pendingTarget] = pendingFixture.sessionIds as [string, string];
      const pendingOperationId = phase7OperationId("status-pending");
      const pendingTargetHandle = createGlobalSessionHandle(pendingFixture.userId, pendingTarget);
      const pendingIntentFingerprint = createSessionRevokeIntentFingerprint("one", pendingTargetHandle);
      const pendingOpeningFingerprint = createHash("sha256").update(`${suffix}:opening:status-pending`).digest("hex");
      await issueFreshAuthGrantForCurrentPassword(phase7Database, phase7Context(pendingFixture.userId, pendingCurrent), { operationId: pendingOperationId, purpose: "session_revoke", openingFingerprint: pendingOpeningFingerprint, intentFingerprint: pendingIntentFingerprint, sessionRevoke: { scope: "one", canonicalTargetHandle: pendingTargetHandle, resolvedTargetSessionId: pendingTarget } }, "synthetic", { verify: async () => true }, undefined, phase7Signer);
      const pendingStatus = await getGlobalSessionRevokeStatus(phase7Database, phase7Context(pendingFixture.userId, pendingCurrent), { operationId: pendingOperationId, openingFingerprint: pendingOpeningFingerprint, intentFingerprint: pendingIntentFingerprint });
      if (pendingStatus.status !== "pending") throw new Error("phase7_pending_status_invalid");
      await phase7AuthDatabase.session.delete({ where: { id: pendingTarget } });
      const pendingRetry = await revokeGlobalSessionSecurityWithCurrentPassword(phase7Database, phase7Context(pendingFixture.userId, pendingCurrent), { operationId: pendingOperationId, openingFingerprint: pendingOpeningFingerprint, intentFingerprint: pendingIntentFingerprint, scope: "one", targetHandle: pendingTargetHandle, confirmed: true }, "not-reverified", { verify: async () => { throw new Error("phase7_pending_retry_password_reverified"); } }, phase7Signer);
      if (pendingRetry.status !== "already_revoked") throw new Error("phase7_pending_removed_target_retry_invalid");
      console.log("phase7_pending_status_retry_pass");
      for (const scope of ["current", "one", "others", "all"] as const satisfies readonly SessionRevokeScope[]) {
        const fixture = await phase7SeedUser(`scope-${scope}`, ["current", "target", "third"]);
        const [currentSessionId, targetSessionId, thirdSessionId] = fixture.sessionIds as [string, string, string];
        const operationId = phase7OperationId(`scope-${scope}`);
        const targetHandle = scope === "current"
          ? createGlobalSessionHandle(fixture.userId, currentSessionId)
          : scope === "one"
            ? createGlobalSessionHandle(fixture.userId, targetSessionId)
            : undefined;
        const intentFingerprint = createSessionRevokeIntentFingerprint(scope, targetHandle ?? "absent_target_handle");
        const openingFingerprint = createHash("sha256").update(`${suffix}:opening:${scope}`).digest("hex");
        const result = await revokeGlobalSessionSecurityWithCurrentPassword(
          phase7Database,
          phase7Context(fixture.userId, currentSessionId),
          { operationId, openingFingerprint, intentFingerprint, scope, targetHandle, confirmed: true },
          randomBytes(24).toString("base64url"),
          { verify: async () => true },
          phase7Signer
        );
        if (result.status !== "revoked") throw new Error(`phase7_${scope}_service_outcome_invalid`);
        const expectedRemaining = scope === "current" ? 2 : scope === "one" ? 2 : scope === "others" ? 1 : 0;
        const expectedVector = scope === "all" ? 2 : 1;
        const expectedRevokedActivities = scope === "current" || scope === "one" ? 1 : scope === "others" ? 2 : 3;
        const expectedActiveActivities = 3 - expectedRevokedActivities;
        sql(`SELECT
          (SELECT COUNT(*) FROM "Session" WHERE "userId"='${fixture.userId}')=${expectedRemaining}
          AND (SELECT "sessionSecurityVersion"=${expectedVector} FROM "AccountSecurityState" WHERE "userId"='${fixture.userId}')
          AND (SELECT ("lastSessionSecurityOperationId" IS NOT DISTINCT FROM ${scope === "all" ? `'${operationId}'` : "NULL"}) FROM "AccountSecurityState" WHERE "userId"='${fixture.userId}')
          AND (SELECT COUNT(*) FROM "SessionSecurityActivity" WHERE "userId"='${fixture.userId}' AND "state"='revoked')=${expectedRevokedActivities}
          AND (SELECT COUNT(*) FROM "SessionSecurityActivity" WHERE "userId"='${fixture.userId}' AND "state"='active')=${expectedActiveActivities}
          AND (SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${fixture.userId}' AND "operationId"='${operationId}' AND "eventType"='operation_outcome' AND "safeProjection"='{}'::jsonb)=1
          AND (SELECT COUNT(*) FROM "GlobalSecurityOperation" WHERE "userId"='${fixture.userId}' AND "operationId"='${operationId}' AND "status"='completed' AND "outcomeCode"='revoked' AND "outcomeSnapshot"='{}'::jsonb)=1`, "t");
        if (scope === "current") {
          sql(`SELECT COUNT(*)=2 AND bool_and("id" IN ('${targetSessionId}','${thirdSessionId}')) FROM "Session" WHERE "userId"='${fixture.userId}'`, "t");
          await authorizeGlobalSessionSecurity(phase7Database, { userId: fixture.userId, sessionId: targetSessionId });
          await authorizeGlobalSessionSecurity(phase7Database, { userId: fixture.userId, sessionId: thirdSessionId });
        }
        if (scope === "one") sql(`SELECT COUNT(*)=2 AND bool_and("id" IN ('${currentSessionId}','${thirdSessionId}')) FROM "Session" WHERE "userId"='${fixture.userId}'`, "t");
        if (scope === "others") sql(`SELECT COUNT(*)=1 AND bool_and("id"='${currentSessionId}') FROM "Session" WHERE "userId"='${fixture.userId}'`, "t");
        if (scope === "all") sql(`SELECT COUNT(*)=0 FROM "Session" WHERE "userId"='${fixture.userId}'`, "t");
        const scopePassMarker: Record<SessionRevokeScope, string> = {
          current: "phase7_session_scope_current_pass",
          one: "phase7_session_scope_one_pass",
          others: "phase7_session_scope_others_pass",
          all: "phase7_session_scope_all_pass"
        };
        console.log(scopePassMarker[scope]);

        if (scope === "one" || scope === "others") {
          const status = await getGlobalSessionRevokeStatus(phase7Database, phase7Context(fixture.userId, currentSessionId), { operationId, openingFingerprint, intentFingerprint });
          if (status.status !== "revoked") throw new Error(`phase7_${scope}_status_invalid`);
          const replayedStatus = await getGlobalSessionRevokeStatus(phase7Database, phase7Context(fixture.userId, currentSessionId), { operationId, openingFingerprint, intentFingerprint });
          if (replayedStatus.status !== status.status) throw new Error(`phase7_${scope}_status_replay_invalid`);
        }
        if (scope === "others") {
          try {
            await revokeGlobalSessionSecurityWithCurrentPassword(phase7Database, phase7Context(fixture.userId, currentSessionId), { operationId, openingFingerprint: `${openingFingerprint.slice(0, -1)}0`, intentFingerprint, scope, confirmed: true }, "not-reverified", { verify: async () => { throw new Error("phase7_conflict_password_reverified"); } }, phase7Signer);
            throw new Error("phase7_conflicting_reuse_not_rejected");
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("idempotency_conflict")) throw error;
          }
          console.log("phase7_session_replay_conflict_pass");
        }
        if (scope === "current" || scope === "all") {
          const replacementSessionId = phase7Id(`session-scope-${scope}-resigned`);
          await phase7AuthDatabase.session.create({ data: { id: replacementSessionId, token: randomBytes(32).toString("base64url"), userId: fixture.userId, expiresAt: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000), userAgent: "Phase7/resigned", createdAt: new Date(), updatedAt: new Date() } });
          await initializeGlobalSessionSecurityActivity(phase7Database, { userId: fixture.userId, sessionId: replacementSessionId });
          const replacementVersion = scope === "all" ? 2 : 1;
          const status = await getGlobalSessionRevokeStatus(phase7Database, phase7Context(fixture.userId, replacementSessionId, replacementVersion), { operationId, openingFingerprint, intentFingerprint });
          if (status.status !== "revoked") throw new Error(`phase7_${scope}_lost_response_status_invalid`);
          const replayedStatus = await getGlobalSessionRevokeStatus(phase7Database, phase7Context(fixture.userId, replacementSessionId, replacementVersion), { operationId, openingFingerprint, intentFingerprint });
          if (replayedStatus.status !== status.status) throw new Error(`phase7_${scope}_lost_response_replay_invalid`);
        }
      }
      console.log("phase7_lost_response_status_pass");
      sql(`SELECT COUNT(*)=4 AND bool_and("safeProjection"='{}'::jsonb) AND bool_and("outcome" IN ('revoked','already_revoked')) FROM "GlobalSecurityEvent" WHERE "eventType"='operation_outcome' AND "userId" LIKE 'phase7-${suffix}-user-scope-%'`, "t");
      sql(`SELECT COUNT(*)=0 FROM "GlobalSecurityEvent" event WHERE event."userId" LIKE 'phase7-${suffix}-user-scope-%' AND (event."safeProjection"::text ~* '(token|handle|192\\.0\\.2\\.7|Phase7/)')`, "t");
      console.log("phase7_session_event_content_free_pass");

      const stale = await phase7SeedUser("vector", ["current", "target"]);
      const staleCurrent = stale.sessionIds[0]!;
      const staleTarget = stale.sessionIds[1]!;
      const staleOperationId = phase7OperationId("stale");
      const staleHandle = createGlobalSessionHandle(stale.userId, staleTarget);
      const staleIntent = createSessionRevokeIntentFingerprint("one", staleHandle);
      const staleOpening = createHash("sha256").update(`${suffix}:stale-opening`).digest("hex");
      await issueFreshAuthGrantForCurrentPassword(phase7Database, phase7Context(stale.userId, staleCurrent), { operationId: staleOperationId, purpose: "session_revoke", openingFingerprint: staleOpening, intentFingerprint: staleIntent, sessionRevoke: { scope: "one", canonicalTargetHandle: staleHandle, resolvedTargetSessionId: staleTarget } }, "synthetic", { verify: async () => true }, undefined, phase7Signer);
      sql(`UPDATE "AccountSecurityState" SET "sessionSecurityVersion"=2,"lastSessionSecurityOperationId"='${phase7OperationId("independent-vector")}',"securityUpdatedAt"=NOW() WHERE "userId"='${stale.userId}'`);
      runtimeSql(`SELECT "status" FROM "complete_session_revoke"('${stale.userId}','${staleCurrent}','${staleOperationId}','${staleOpening}','${staleIntent}')`, "stale_security_version");
      sql(`SELECT COUNT(*)=1 FROM "GlobalSecurityEvent" WHERE "userId"='${stale.userId}' AND "operationId"='${staleOperationId}' AND "eventType"='operation_outcome' AND "outcome"='stale_security_version' AND "safeProjection"='{}'::jsonb`, "t");
      const staleReplacement = phase7Id("session-vector-resigned");
      await phase7AuthDatabase.session.create({ data: { id: staleReplacement, token: randomBytes(32).toString("base64url"), userId: stale.userId, expiresAt: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000), userAgent: "Phase7/vector-resigned", createdAt: new Date(), updatedAt: new Date() } });
      await initializeGlobalSessionSecurityActivity(phase7Database, { userId: stale.userId, sessionId: staleReplacement });
      const staleStatus = await getGlobalSessionRevokeStatus(phase7Database, phase7Context(stale.userId, staleReplacement, 2), { operationId: staleOperationId, openingFingerprint: staleOpening, intentFingerprint: staleIntent });
      if (staleStatus.status !== "stale_security_version") throw new Error("phase7_stale_status_invalid");
      await authorizeGlobalSessionSecurity(phase7Database, { userId: stale.userId, sessionId: staleCurrent }).then(() => { throw new Error("phase7_issuance_mismatch_not_denied"); }, (error) => { if (!(error instanceof Error) || error.message !== "unauthenticated") throw error; });
      sql(`SELECT (SELECT COUNT(*) FROM "Session" WHERE "id"='${staleCurrent}')=0 AND (SELECT "state"='revoked' FROM "SessionSecurityActivity" WHERE "sessionId"='${staleCurrent}')`, "t");
      console.log("phase7_issuance_version_stale_pass");

      const already = await phase7SeedUser("already", ["current", "target"]);
      const alreadyCurrent = already.sessionIds[0]!;
      const alreadyTarget = already.sessionIds[1]!;
      const alreadyOperationId = phase7OperationId("already");
      const alreadyHandle = createGlobalSessionHandle(already.userId, alreadyTarget);
      const alreadyIntent = createSessionRevokeIntentFingerprint("one", alreadyHandle);
      const alreadyOpening = createHash("sha256").update(`${suffix}:already-opening`).digest("hex");
      await issueFreshAuthGrantForCurrentPassword(phase7Database, phase7Context(already.userId, alreadyCurrent), { operationId: alreadyOperationId, purpose: "session_revoke", openingFingerprint: alreadyOpening, intentFingerprint: alreadyIntent, sessionRevoke: { scope: "one", canonicalTargetHandle: alreadyHandle, resolvedTargetSessionId: alreadyTarget } }, "synthetic", { verify: async () => true }, undefined, phase7Signer);
      await phase7AuthDatabase.session.delete({ where: { id: alreadyTarget } });
      runtimeSql(`SELECT "status" FROM "complete_session_revoke"('${already.userId}','${alreadyCurrent}','${alreadyOperationId}','${alreadyOpening}','${alreadyIntent}')`, "already_revoked");
      sql(`SELECT (SELECT COUNT(*) FROM "Session" WHERE "userId"='${already.userId}')=1 AND (SELECT "sessionSecurityVersion"=1 AND "lastSessionSecurityOperationId" IS NULL FROM "AccountSecurityState" WHERE "userId"='${already.userId}') AND (SELECT "state"='revoked' FROM "SessionSecurityActivity" WHERE "sessionId"='${alreadyTarget}') AND (SELECT COUNT(*) FROM "GlobalSecurityEvent" WHERE "userId"='${already.userId}' AND "operationId"='${alreadyOperationId}' AND "eventType"='operation_outcome' AND "outcome"='already_revoked' AND "safeProjection"='{}'::jsonb)=1`, "t");
      console.log("phase7_already_revoked_pass");

      const lifetime = await phase7SeedUser("lifetime", ["idle", "absolute", "warning", "qualifying"]);
      const [idleSession, absoluteSession, warningSession, qualifyingSession] = lifetime.sessionIds as [string, string, string, string];
      sql(`BEGIN; ALTER TABLE "SessionSecurityActivity" DISABLE TRIGGER ALL;
        UPDATE "Session" SET "createdAt"=NOW()-INTERVAL '31 days' WHERE "id"='${idleSession}';
        UPDATE "Session" SET "createdAt"=NOW()-INTERVAL '91 days' WHERE "id"='${absoluteSession}';
        UPDATE "Session" SET "createdAt"=NOW()-INTERVAL '24 days' WHERE "id"='${warningSession}';
        UPDATE "Session" SET "createdAt"=NOW()-INTERVAL '2 days' WHERE "id"='${qualifyingSession}';
        UPDATE "SessionSecurityActivity" SET "originalCreatedAt"=NOW()-INTERVAL '31 days',"lastQualifyingAt"=NOW()-INTERVAL '31 days',"updatedAt"=NOW() WHERE "sessionId"='${idleSession}';
        UPDATE "SessionSecurityActivity" SET "originalCreatedAt"=NOW()-INTERVAL '91 days',"lastQualifyingAt"=NOW(),"updatedAt"=NOW() WHERE "sessionId"='${absoluteSession}';
        UPDATE "SessionSecurityActivity" SET "originalCreatedAt"=NOW()-INTERVAL '24 days',"lastQualifyingAt"=NOW()-INTERVAL '24 days',"updatedAt"=NOW() WHERE "sessionId"='${warningSession}';
        UPDATE "SessionSecurityActivity" SET "originalCreatedAt"=NOW()-INTERVAL '2 days',"lastQualifyingAt"=NOW()-INTERVAL '1 day',"updatedAt"=NOW() WHERE "sessionId"='${qualifyingSession}';
        ALTER TABLE "SessionSecurityActivity" ENABLE TRIGGER ALL; COMMIT`);
      await authorizeGlobalSessionSecurity(phase7Database, { userId: lifetime.userId, sessionId: idleSession }).then(() => { throw new Error("phase7_idle_not_denied"); }, (error) => { if (!(error instanceof Error) || error.message !== "unauthenticated") throw error; });
      sql(`SELECT (SELECT COUNT(*) FROM "Session" WHERE "id"='${idleSession}')=0 AND (SELECT "state"='expired' FROM "SessionSecurityActivity" WHERE "sessionId"='${idleSession}')`, "t");
      console.log("phase7_idle_lifetime_pass");
      await authorizeGlobalSessionSecurity(phase7Database, { userId: lifetime.userId, sessionId: absoluteSession }).then(() => { throw new Error("phase7_absolute_not_denied"); }, (error) => { if (!(error instanceof Error) || error.message !== "unauthenticated") throw error; });
      sql(`SELECT (SELECT COUNT(*) FROM "Session" WHERE "id"='${absoluteSession}')=0 AND (SELECT "state"='expired' FROM "SessionSecurityActivity" WHERE "sessionId"='${absoluteSession}')`, "t");
      console.log("phase7_absolute_lifetime_pass");
      const warningBefore = runtimeSql(`SELECT "lastQualifyingAt"::text FROM "SessionSecurityActivity" WHERE "sessionId"='${warningSession}'`);
      const warningAuthorization = await authorizeGlobalSessionSecurity(phase7Database, { userId: lifetime.userId, sessionId: warningSession });
      if (!warningAuthorization.idleWarningAt) throw new Error("phase7_warning_missing");
      const warningAfter = runtimeSql(`SELECT "lastQualifyingAt"::text FROM "SessionSecurityActivity" WHERE "sessionId"='${warningSession}'`);
      if (warningAfter !== warningBefore) throw new Error("phase7_warning_extended_activity");
      console.log("phase7_warning_non_extension_pass");
      const qualifyingBefore = runtimeSql(`SELECT "lastQualifyingAt"::text FROM "SessionSecurityActivity" WHERE "sessionId"='${qualifyingSession}'`);
      await authorizeGlobalSessionSecurity(phase7Database, { userId: lifetime.userId, sessionId: qualifyingSession });
      const excludedAfter = runtimeSql(`SELECT "lastQualifyingAt"::text FROM "SessionSecurityActivity" WHERE "sessionId"='${qualifyingSession}'`);
      if (excludedAfter !== qualifyingBefore) throw new Error("phase7_excluded_use_extended_activity");
      rejectRuntimeSql(`SELECT * FROM "authorize_global_session_security"('${lifetime.userId}','${qualifyingSession}','prefetch')`, "session_security_qualifying_use_invalid");
      await recordQualifyingGlobalSessionUseAfterSuccess(phase7Database, { userId: lifetime.userId, sessionId: qualifyingSession }, "foreground_document_navigation");
      const qualifyingAfter = runtimeSql(`SELECT "lastQualifyingAt">'${qualifyingBefore}'::timestamp FROM "SessionSecurityActivity" WHERE "sessionId"='${qualifyingSession}'`);
      if (qualifyingAfter !== "t") throw new Error("phase7_qualifying_use_not_recorded");
      console.log("phase7_qualifying_use_classification_pass");
      await observeTransitionWait("phase7_session_lock", `SELECT * FROM "authorize_global_session_security"('${lifetime.userId}','${warningSession}',NULL)`);
      console.log("phase7_session_lock_wait_observed");
    } finally {
      await phase7Database.$disconnect();
      await phase7AuthDatabase.$disconnect();
    }

    sql(`INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u23','Synthetic User Twenty Three','u23@acceptance.invalid',true,NOW(),NOW()); INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u23',1,1,NOW()); INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('session-u23','token-u23',NOW()+INTERVAL '1 day','u23',NOW(),NOW())`);
    runtimeSql(`BEGIN; INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","sessionSecurityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-password-u23','u23','session-u23','gso_44444444444444444444444444','password_change',1,1,'opening-password-u23','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW()); INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-password-u23','u23','gso_44444444444444444444444444','password_change','intent-password-u23','pending',NOW(),NOW()); UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-password-u23'; COMMIT`);
    rejectRuntimeSql(`INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('forged-password-grant-u23','u23','session-u23','gso_44444444444444444444444444','password_change',1,'issued',NOW()+INTERVAL '10 minutes',NOW())`, "fresh_auth_attestation_invalid");
    console.log("phase4_runtime_forged_password_authority_chain_rejected");
    const attestedHash = "attested-new-hash";
    const attestedDigest = createHash("sha256").update(attestedHash).digest();
    const attestedNonce = Buffer.alloc(32, 0x22).toString("base64url");
    const attestedHex = (value: string) => Buffer.from(value, "utf8").toString("hex");
    const attestedPayload = ["fresh-auth-attestation-v1",attestedHex("u23"),attestedHex("session-u23"),attestedHex("gso_44444444444444444444444444"),"password_change","1","1",attestedHex("opening-password-u23"),attestedHex("intent-password-u23"),attestedDigest.toString("hex"),attestedHex(attestedNonce),"1"].join("|");
    const attestedMac = createHmac("sha256", Buffer.alloc(32, 0x11)).update(attestedPayload).digest();
    sql(`INSERT INTO "Account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('credential-account-u23','credential-u23','credential','u23','original-hash-u23',NOW(),NOW())`);
    runtimeSql(`INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","attestationNonce","attestationMac","attestationKeyVersion","replacementPasswordHashDigest","state","expiresAt","createdAt") VALUES ('attested-password-grant-u23','u23','session-u23','gso_44444444444444444444444444','password_change',1,'${attestedNonce}',decode('${attestedMac.toString("hex")}','hex'),1,decode('${attestedDigest.toString("hex")}','hex'),'issued',NOW()+INTERVAL '10 minutes',NOW())`);
    rejectRuntimeSql(`BEGIN; UPDATE "FreshAuthGrant" SET "state"='consumed',"consumedAt"=NOW() WHERE "id"='attested-password-grant-u23'; UPDATE "AccountSecurityState" SET "credentialVersion"=2,"sessionSecurityVersion"=2,"lastCredentialOperationId"='gso_44444444444444444444444444',"lastSessionSecurityOperationId"='gso_44444444444444444444444444',"securityUpdatedAt"=NOW() WHERE "userId"='u23'; SELECT "apply_password_change_credential_mutation"('u23','gso_44444444444444444444444444','credential-account-u23','attacker-substituted-hash'); COMMIT`, "replacement_password_hash_attestation_mismatch");
    sql(`SELECT "password" FROM "Account" WHERE "id"='credential-account-u23'`, "original-hash-u23");
    console.log("phase4_runtime_attested_hash_substitution_rejected");
    sql(`INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u24','Synthetic User Twenty Four','u24@acceptance.invalid',true,NOW(),NOW()); INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u24',1,1,NOW()); INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('service-password-session-u24','service-password-token-u24',NOW()+INTERVAL '1 day','u24',NOW(),NOW()); INSERT INTO "Account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('service-password-account-u24','service-password-credential-u24','credential','u24','service-password-old-hash',NOW(),NOW())`);

    const serviceEnrollmentOperationId = "gso_22222222222222222222222222";
    const serviceResetOperationId = "gso_33333333333333333333333333";
    sql(`INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u22','Synthetic User Twenty Two','u22@acceptance.invalid',true,NOW(),NOW());
      INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u22',1,1,NOW());
      INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('service-session-u22','service-token-u22',NOW()+INTERVAL '1 day','u22',NOW(),NOW());
      INSERT INTO "Account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('service-credential-u22','service-credential-provider-u22','credential','u22','service-old-hash',NOW(),NOW())`);
    const serviceDatabase = new PrismaClient({ datasourceUrl: runtimeDatabaseUrl.toString() });
    try {
      await changePasswordWithCurrentPassword(serviceDatabase, { userId: "u24", sessionId: "service-password-session-u24", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: "gso_55555555555555555555555555", openingFingerprint: "service-password-opening-u24", intentFingerprint: "service-password-intent-u24" }, "service-current-password", "service-new-password", { verify: async () => true }, { hash: async () => "service-password-new-hash" }, createFreshAuthAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${Buffer.alloc(32, 0x11).toString("base64url")}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" }));
      console.log("phase4_attested_password_service_lifecycle_pass");
      const serviceContext = { userId: "u22", sessionId: "service-session-u22", credentialVersion: 1, sessionSecurityVersion: 1 };
      await issueFreshAuthGrantForCurrentPassword(serviceDatabase, serviceContext, { operationId: serviceEnrollmentOperationId, purpose: "recovery_enrollment", openingFingerprint: "service-opening-u22", intentFingerprint: "service-intent-u22" }, "service-current-password", { verify: async () => true }, undefined, createFreshAuthAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${Buffer.alloc(32, 0x11).toString("base64url")}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" }));
      const serviceCodes = Array.from({ length: 10 }, (_, index) => `0000-0000-0000-0000-0000-${String(index).padStart(4, "0")}`);
      const enrollment = await issueRecoveryCodeSet(serviceDatabase, serviceContext, { operationId: serviceEnrollmentOperationId, openingFingerprint: "service-opening-u22", intentFingerprint: "service-intent-u22" }, { generate: () => serviceCodes, hash: async (_code, ordinal) => ({ salt: Buffer.alloc(16, ordinal), derivedKey: Buffer.alloc(32, ordinal), kdfVersion: 1 }) });
      await acknowledgeRecoveryCodeSetSaved(serviceDatabase, serviceContext, { operationId: serviceEnrollmentOperationId, setVersion: enrollment.setVersion });
      await rehearseRecoveryCodeSet(serviceDatabase, serviceContext, { operationId: serviceEnrollmentOperationId, openingFingerprint: "service-opening-u22", intentFingerprint: "service-intent-u22", setVersion: enrollment.setVersion, code: serviceCodes[0]! }, { verify: async (_code, record) => record.derivedKey[0] === 1 });
      const enrollmentStatus = await getRecoveryEnrollmentStatus(serviceDatabase, serviceContext, { operationId: serviceEnrollmentOperationId, openingFingerprint: "service-opening-u22", intentFingerprint: "service-intent-u22" });
      if (enrollmentStatus.state !== "rehearsed" || enrollmentStatus.remainingCodes !== 9) throw new Error("p1_3_phase5_service_enrollment_status_invalid");
      const forgedRecoveryCode = await serviceDatabase.recoveryCode.findFirstOrThrow({ where: { userId: "u22", setVersion: enrollment.setVersion, ordinal: 2 }, select: { id: true } });
      rejectRuntimeSql(`INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","createdAt") VALUES ('forged-recovery-session-u22','u22','${forgedRecoveryCode.id}','gso_77777777777777777777777777','recovery_reset','restricted',NOW()+INTERVAL '10 minutes',NOW())`, "recovery_reset_attestation_invalid");
      console.log("phase5_runtime_forged_recovery_authority_chain_rejected");
      const reset = await recoverPasswordWithCode(serviceDatabase, { userId: "u22", operationId: serviceResetOperationId, openingFingerprint: "service-reset-opening-u22", intentFingerprint: "service-reset-intent-u22", code: serviceCodes[1]!, credentialVersion: 1, sessionSecurityVersion: 1 }, "service-new-password", { hash: async () => "service-new-hash" }, { verify: async (_code, record) => record.derivedKey[0] === 2 }, createFreshAuthAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${Buffer.alloc(32, 0x11).toString("base64url")}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" }));
      const resetStatus = await getRecoveryResetStatus(serviceDatabase, { userId: "u22", recoverySessionId: reset.recoverySessionId, operationId: serviceResetOperationId, openingFingerprint: "service-reset-opening-u22", intentFingerprint: "service-reset-intent-u22" });
      if (resetStatus.status !== "completed" || resetStatus.outcomeCode !== "reset_completed" || resetStatus.state !== "closed") throw new Error("p1_3_phase5_service_reset_status_invalid");
      sql(`SELECT string_agg(value,',' ORDER BY value) FROM (SELECT "outcome" || ':' || COUNT(*) value FROM "GlobalSecurityEvent" WHERE "userId"='u22' AND "eventType"='recovery' GROUP BY "outcome") outcomes`, "code_set_generated:1,rehearsed:1,reset_completed:1,reset_started:1");
      console.log("PHASE8_RECOVERY_REHEARSAL_RESET_CARDINALITY_PASS");
      const substitution = await beginRecoveryReset(serviceDatabase, { userId: "u22", operationId: "gso_66666666666666666666666666", openingFingerprint: "service-substitution-opening-u22", intentFingerprint: "service-substitution-intent-u22", code: serviceCodes[2]! }, { verify: async (_code, record) => record.derivedKey[0] === 3 }, { replacementPasswordHash: "service-exact-substitution-hash", signer: createFreshAuthAttestationSigner({ CUBBY_FRESH_AUTH_ATTESTATION_KEYRING: `1:${Buffer.alloc(32, 0x11).toString("base64url")}`, CUBBY_FRESH_AUTH_ATTESTATION_ACTIVE_KEY_VERSION: "1" }) });
      rejectRuntimeSql(`BEGIN; UPDATE "AccountSecurityState" SET "credentialVersion"=3,"sessionSecurityVersion"=3,"lastCredentialOperationId"='gso_66666666666666666666666666',"lastSessionSecurityOperationId"='gso_66666666666666666666666666',"securityUpdatedAt"=NOW() WHERE "userId"='u22'; SELECT "apply_recovery_reset_credential_mutation"('u22','gso_66666666666666666666666666','service-credential-u22','attacker-recovery-substitution-hash'); COMMIT`, "recovery_reset_attestation_invalid");
      if (!substitution.recoverySessionId) throw new Error("p1_3_phase5_substitution_carrier_missing");
      console.log("phase5_runtime_attested_recovery_hash_substitution_rejected");
      console.log("phase5_recovery_service_lifecycle_pass");
    } finally {
      await serviceDatabase.$disconnect();
    }

    const phase6Database = new PrismaClient({ datasourceUrl: runtimeDatabaseUrl.toString() });
    const phase6AuthDatabase = new PrismaClient({ datasourceUrl: authDatabaseUrl.toString() });
    const phase6DeliveryDatabase = new PrismaClient({ datasourceUrl: deliveryDatabaseUrl.toString() });
    const phase6Cipher = createEmailDeliveryCipher({ CUBBY_EMAIL_DELIVERY_KEYRING: emailDeliveryKeyring, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" });
    const runEmailChangeLifecycle = async (fixture: { userId: string; operationId: string; oldSessionId: string; successorSessionId: string; successorToken: string; verificationToken: string; oldEmail: string; newEmail: string; cookieOutcome: "confirmed" | "failed" | "issued" }) => {
      const context = { userId: fixture.userId, sessionId: fixture.oldSessionId, credentialVersion: 1, sessionSecurityVersion: 1 };
      await initiateVerifiedEmailChange(phase6Database, context, { operationId: fixture.operationId, openingFingerprint: `phase6-opening-${fixture.userId}`, intentFingerprint: `phase6-intent-${fixture.userId}`, newEmail: fixture.newEmail }, "phase6-current-password", { verifier: { verify: async () => true }, generateToken: () => fixture.verificationToken, cipher: phase6Cipher });
      const replay = await initiateVerifiedEmailChange(phase6Database, context, { operationId: fixture.operationId, openingFingerprint: `phase6-opening-${fixture.userId}`, intentFingerprint: `phase6-intent-${fixture.userId}`, newEmail: fixture.newEmail }, "not-rechecked", { verifier: { verify: async () => { throw new Error("phase6_replay_password_rechecked"); } }, generateToken: () => { throw new Error("phase6_replay_token_regenerated"); }, cipher: phase6Cipher });
      if (replay.status !== "pending") throw new Error("phase6_initiation_replay_invalid");
      let verificationAccepted = false;
      for (let attempt = 0; attempt < 20 && !verificationAccepted; attempt += 1) {
        const delivery = await dispatchEmailChangeDelivery(phase6DeliveryDatabase, randomBytes(16).toString("base64url"), { cipher: phase6Cipher, smtp: { send: async (payload) => ({ responseCode: 250, messageId: payload.messageId, accepted: [payload.recipient] }) } });
        if (delivery.status === "idle") break;
        verificationAccepted = await phase6Database.emailChangeDelivery.count({ where: { operationId: fixture.operationId, kind: "newVerification", state: "accepted" } }) === 1;
      }
      if (!verificationAccepted) throw new Error("phase6_verification_delivery_not_accepted");
      const verified = await verifyEmailChangeToken(phase6Database, { userId: fixture.userId, operationId: fixture.operationId, token: fixture.verificationToken });
      if (verified.status !== "verified") throw new Error("phase6_verification_invalid");
      const completed = await completeVerifiedEmailChange(phase6Database, { userId: fixture.userId, operationId: fixture.operationId, oldSessionId: fixture.oldSessionId, successorSessionId: fixture.successorSessionId, successorToken: fixture.successorToken, successorExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }, { generateInviteToken: () => `phase6-replacement-${fixture.userId}`, cipher: phase6Cipher });
      if (completed.status !== "completed") throw new Error("phase6_cutover_invalid");
      if (fixture.cookieOutcome === "failed") {
        const failed = await failEmailChangeRotationCookie(phase6Database, { userId: fixture.userId, operationId: fixture.operationId });
        if (failed.status !== "failed") throw new Error("phase6_cookie_failure_invalid");
      } else if (fixture.cookieOutcome === "confirmed") {
        const confirmed = await confirmEmailChangeRotationCookie(phase6Database, { userId: fixture.userId, operationId: fixture.operationId, successorSessionId: fixture.successorSessionId, successorToken: fixture.successorToken });
        if (confirmed.status !== "confirmed") throw new Error("phase6_cookie_confirmation_invalid");
      }
    };
    try {
      sql(`
        INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES
          ('u25','Phase Six User','old-u25@acceptance.invalid',true,NOW(),NOW()),
          ('u26','Phase Six Failure User','old-u26@acceptance.invalid',true,NOW(),NOW()),
          ('u27','Phase Six Race One','old-u27@acceptance.invalid',true,NOW(),NOW()),
          ('u28','Phase Six Race Two','old-u28@acceptance.invalid',true,NOW(),NOW()),
          ('u29','Phase Six Stale','old-u29@acceptance.invalid',true,NOW(),NOW()),
          ('u30','Phase Six Expiry','old-u30@acceptance.invalid',true,NOW(),NOW()),
          ('u31','Phase Six Delivery Failure','old-u31@acceptance.invalid',true,NOW(),NOW()),
          ('u32','Phase Six Supersession','old-u32@acceptance.invalid',true,NOW(),NOW()),
          ('u33','Phase Six Passive Expiry','old-u33@acceptance.invalid',true,NOW(),NOW()),
          ('u34','Phase Six Cookie Expiry','old-u34@acceptance.invalid',true,NOW(),NOW()),
          ('phase6-inviter','Phase Six Inviter','inviter@acceptance.invalid',true,NOW(),NOW());
        INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u25',1,1,NOW()),('u26',1,1,NOW()),('u27',1,1,NOW()),('u28',1,1,NOW()),('u29',1,1,NOW()),('u30',1,1,NOW()),('u31',1,1,NOW()),('u32',1,1,NOW()),('u33',1,1,NOW()),('u34',1,1,NOW());
        INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES
          ('phase6-old-session-u25','phase6-old-token-u25',NOW()+INTERVAL '1 day','u25',NOW()-INTERVAL '2 days',NOW()),
          ('phase6-old-session-u26','phase6-old-token-u26',NOW()+INTERVAL '1 day','u26',NOW()-INTERVAL '3 days',NOW()),
          ('phase6-old-session-u27','phase6-old-token-u27',NOW()+INTERVAL '1 day','u27',NOW(),NOW()),
          ('phase6-old-session-u28','phase6-old-token-u28',NOW()+INTERVAL '1 day','u28',NOW(),NOW()),
          ('phase6-old-session-u29','phase6-old-token-u29',NOW()+INTERVAL '1 day','u29',NOW(),NOW()),
          ('phase6-old-session-u30','phase6-old-token-u30',NOW()+INTERVAL '1 day','u30',NOW(),NOW()),
          ('phase6-old-session-u31','phase6-old-token-u31',NOW()+INTERVAL '1 day','u31',NOW(),NOW()),
          ('phase6-old-session-u32','phase6-old-token-u32',NOW()+INTERVAL '1 day','u32',NOW(),NOW()),
          ('phase6-old-session-u33','phase6-old-token-u33',NOW()+INTERVAL '1 day','u33',NOW(),NOW()),
          ('phase6-old-session-u34','phase6-old-token-u34',NOW()+INTERVAL '1 day','u34',NOW(),NOW());
        INSERT INTO "SessionSecurityActivity" ("sessionId","userId","issuanceSessionSecurityVersion","originalCreatedAt","lastQualifyingAt","state","updatedAt") SELECT session_row."id",session_row."userId",state_row."sessionSecurityVersion",session_row."createdAt",NOW(),'active',NOW() FROM "Session" session_row JOIN "AccountSecurityState" state_row ON state_row."userId"=session_row."userId" WHERE session_row."id" LIKE 'phase6-old-session-u%';
        INSERT INTO "Account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES
          ('phase6-account-u25','phase6-credential-u25','credential','u25','phase6-hash-u25',NOW(),NOW()),
          ('phase6-account-u26','phase6-credential-u26','credential','u26','phase6-hash-u26',NOW(),NOW()),
          ('phase6-account-u27','phase6-credential-u27','credential','u27','phase6-hash-u27',NOW(),NOW()),
          ('phase6-account-u28','phase6-credential-u28','credential','u28','phase6-hash-u28',NOW(),NOW()),
          ('phase6-account-u29','phase6-credential-u29','credential','u29','phase6-hash-u29',NOW(),NOW()),
          ('phase6-account-u30','phase6-credential-u30','credential','u30','phase6-hash-u30',NOW(),NOW()),
          ('phase6-account-u31','phase6-credential-u31','credential','u31','phase6-hash-u31',NOW(),NOW()),
          ('phase6-account-u32','phase6-credential-u32','credential','u32','phase6-hash-u32',NOW(),NOW()),
          ('phase6-account-u33','phase6-credential-u33','credential','u33','phase6-hash-u33',NOW(),NOW()),
          ('phase6-account-u34','phase6-credential-u34','credential','u34','phase6-hash-u34',NOW(),NOW());
        INSERT INTO "Household" ("id","name","createdByUserId","createdAt","updatedAt") VALUES ('phase6-household','Phase Six Household','phase6-inviter',NOW(),NOW());
        INSERT INTO "Invite" ("id","householdId","email","role","tokenHash","status","invitedByUserId","expiresAt","createdAt","updatedAt") VALUES ('phase6-old-invite','phase6-household','old-u25@acceptance.invalid','parent','sha256:${createHash("sha256").update("phase6-old-invite-token").digest("hex")}','pending','phase6-inviter',NOW()+INTERVAL '2 days',NOW(),NOW());
      `);
      await runEmailChangeLifecycle({ userId: "u25", operationId: "gso_88888888888888888888888888", oldSessionId: "phase6-old-session-u25", successorSessionId: "phase6-successor-u25", successorToken: "phase6-successor-token-u25", verificationToken: "phase6-verification-token-u25", oldEmail: "old-u25@acceptance.invalid", newEmail: "new-u25@acceptance.invalid", cookieOutcome: "issued" });
      await runEmailChangeLifecycle({ userId: "u26", operationId: "gso_99999999999999999999999999", oldSessionId: "phase6-old-session-u26", successorSessionId: "phase6-successor-u26", successorToken: "phase6-successor-token-u26", verificationToken: "phase6-verification-token-u26", oldEmail: "old-u26@acceptance.invalid", newEmail: "new-u26@acceptance.invalid", cookieOutcome: "issued" });
      const betterAuthApplication = await startPhase6BetterAuthApplication({ database: phase6Database, authDatabase: phase6AuthDatabase, success: { userId: "u25", operationId: "gso_88888888888888888888888888", sessionId: "phase6-successor-u25", token: "phase6-successor-token-u25" }, failure: { userId: "u26", operationId: "gso_99999999999999999999999999", sessionId: "phase6-successor-u26", token: "phase6-successor-token-u26" } });
      try {
        await runP13EmailChangeBrowserAcceptance(betterAuthApplication.origin);
      } finally {
        await betterAuthApplication.close();
      }
      sql(`SELECT (SELECT "cookieState" FROM "EmailChangeSessionRotation" WHERE "userId"='u25') || '|' || (SELECT "cookieState" FROM "EmailChangeSessionRotation" WHERE "userId"='u26') || '|' || (SELECT count(*) FROM "Session" WHERE "id"='phase6-successor-u26')`, "confirmed|failed|0");
      const initiateOnly = (userId: string, operationId: string, newEmail: string) => initiateVerifiedEmailChange(phase6Database, { userId, sessionId: `phase6-old-session-${userId}`, credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId, openingFingerprint: `phase6-opening-${operationId}`, intentFingerprint: `phase6-intent-${operationId}`, newEmail }, "phase6-current-password", { verifier: { verify: async () => true }, generateToken: () => `phase6-token-${operationId}`, cipher: phase6Cipher });
      const phase6OperationId = (character: string) => `gso_${character.repeat(26)}`;

      const passiveExpiryOperationId = phase6OperationId("k");
      await initiateOnly("u33", passiveExpiryOperationId, "new-u33@acceptance.invalid");
      const cookieExpiryOperationId = phase6OperationId("j");
      await runEmailChangeLifecycle({ userId: "u34", operationId: cookieExpiryOperationId, oldSessionId: "phase6-old-session-u34", successorSessionId: "phase6-successor-u34", successorToken: "phase6-successor-token-u34", verificationToken: "phase6-verification-token-u34", oldEmail: "old-u34@acceptance.invalid", newEmail: "new-u34@acceptance.invalid", cookieOutcome: "issued" });
      sql(`BEGIN; ALTER TABLE "EmailChange" DISABLE TRIGGER "00_EmailChange_runtime_transition_guard"; ALTER TABLE "EmailChange" DISABLE TRIGGER "EmailChange_state_guard"; UPDATE "EmailChange" SET "expiresAt"=NOW()-INTERVAL '1 second' WHERE "userId"='u33' AND "operationId"='${passiveExpiryOperationId}'; ALTER TABLE "EmailChange" ENABLE TRIGGER "EmailChange_state_guard"; ALTER TABLE "EmailChange" ENABLE TRIGGER "00_EmailChange_runtime_transition_guard"; ALTER TABLE "EmailChangeSessionRotation" DISABLE TRIGGER "00_EmailChangeSessionRotation_runtime_transition_guard"; ALTER TABLE "EmailChangeSessionRotation" DISABLE TRIGGER "EmailChangeSessionRotation_state_guard"; UPDATE "EmailChangeSessionRotation" SET "issuedAt"=NOW()-INTERVAL '6 minutes' WHERE "userId"='u34' AND "operationId"='${cookieExpiryOperationId}'; ALTER TABLE "EmailChangeSessionRotation" ENABLE TRIGGER "EmailChangeSessionRotation_state_guard"; ALTER TABLE "EmailChangeSessionRotation" ENABLE TRIGGER "00_EmailChangeSessionRotation_runtime_transition_guard"; COMMIT`);
      const lifecycleBatch = await runEmailChangeLifecycleWorkerTick(phase6Database, 25);
      if (lifecycleBatch.expiredChanges !== 1 || lifecycleBatch.expiredRotations !== 1) throw new Error("phase6_lifecycle_batch_counts_invalid");
      sql(`SELECT (SELECT "status" || '|' || "outcomeCode" FROM "GlobalSecurityOperation" WHERE "userId"='u33' AND "operationId"='${passiveExpiryOperationId}') || '|' || (SELECT "cookieState" FROM "EmailChangeSessionRotation" WHERE "userId"='u34' AND "operationId"='${cookieExpiryOperationId}') || '|' || (SELECT count(*) FROM "Session" WHERE "id"='phase6-successor-u34')`, "rejected|verification_expired|failed|0");

      const existingCollisionOperationId = phase6OperationId("a");
      const existingCollision = await initiateOnly("u27", existingCollisionOperationId, "inviter@acceptance.invalid");
      if (existingCollision.status !== "rejected") throw new Error("phase6_existing_identity_collision_not_rejected");
      sql(`SELECT "status" || '|' || "outcomeCode" FROM "GlobalSecurityOperation" WHERE "userId"='u27' AND "operationId"='${existingCollisionOperationId}'`, "rejected|collision_rejected");

      const raceTarget = "phase6-race@acceptance.invalid";
      const firstRaceOperationId = phase6OperationId("b");
      const secondRaceOperationId = phase6OperationId("c");
      const raceResults = await Promise.all([
        initiateOnly("u27", firstRaceOperationId, raceTarget),
        initiateOnly("u28", secondRaceOperationId, raceTarget)
      ]);
      if (raceResults.filter(({ status }) => status === "pending").length !== 1 || raceResults.filter(({ status }) => status === "rejected").length !== 1) throw new Error("phase6_live_identity_race_not_serialized");
      const racePending = raceResults[0]!.status === "pending"
        ? { userId: "u27", operationId: firstRaceOperationId, sessionId: "phase6-old-session-u27" }
        : { userId: "u28", operationId: secondRaceOperationId, sessionId: "phase6-old-session-u28" };
      await cancelVerifiedEmailChange(phase6Database, racePending);

      const staleOperationId = phase6OperationId("d");
      await initiateOnly("u29", staleOperationId, "new-u29@acceptance.invalid");
      sql(`UPDATE "AccountSecurityState" SET "credentialVersion"=2,"lastCredentialOperationId"='${phase6OperationId("z")}',"securityUpdatedAt"=NOW() WHERE "userId"='u29'`);
      try {
        await initiateVerifiedEmailChange(phase6Database, { userId: "u29", sessionId: "phase6-old-session-u29", credentialVersion: 1, sessionSecurityVersion: 1 }, { operationId: staleOperationId, openingFingerprint: `phase6-opening-${staleOperationId}`, intentFingerprint: `phase6-intent-${staleOperationId}`, newEmail: "new-u29@acceptance.invalid" }, "not-rechecked", { verifier: { verify: async () => { throw new Error("phase6_stale_password_rechecked"); } }, cipher: phase6Cipher });
        throw new Error("phase6_stale_replay_not_rejected");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("stale_security_version")) throw error;
      }
      sql(`SELECT "status" || '|' || "outcomeCode" FROM "GlobalSecurityOperation" WHERE "userId"='u29' AND "operationId"='${staleOperationId}'`, "stale|stale_security_version");

      const expiryOperationId = phase6OperationId("e");
      await initiateOnly("u30", expiryOperationId, "new-u30@acceptance.invalid");
      sql(`BEGIN; ALTER TABLE "EmailChange" DISABLE TRIGGER "00_EmailChange_runtime_transition_guard"; ALTER TABLE "EmailChange" DISABLE TRIGGER "EmailChange_state_guard"; UPDATE "EmailChange" SET "expiresAt"=NOW()-INTERVAL '1 second' WHERE "userId"='u30' AND "operationId"='${expiryOperationId}'; ALTER TABLE "EmailChange" ENABLE TRIGGER "EmailChange_state_guard"; ALTER TABLE "EmailChange" ENABLE TRIGGER "00_EmailChange_runtime_transition_guard"; COMMIT`);
      await expireVerifiedEmailChange(phase6Database, { userId: "u30", operationId: expiryOperationId });
      sql(`SELECT "status" || '|' || "outcomeCode" FROM "GlobalSecurityOperation" WHERE "userId"='u30' AND "operationId"='${expiryOperationId}'`, "rejected|verification_expired");

      const failedDeliveryOperationId = phase6OperationId("f");
      await initiateOnly("u31", failedDeliveryOperationId, "new-u31@acceptance.invalid");
      let deliveryFailureClosed = false;
      for (let attempt = 0; attempt < 30 && !deliveryFailureClosed; attempt += 1) {
        const result = await dispatchEmailChangeDelivery(phase6DeliveryDatabase, randomBytes(16).toString("base64url"), { cipher: phase6Cipher, smtp: { send: async () => { throw new Error("smtp_rejected"); } } });
        if (result.status === "idle") break;
        deliveryFailureClosed = await phase6Database.globalSecurityOperation.count({ where: { userId: "u31", operationId: failedDeliveryOperationId, status: "rejected", outcomeCode: "delivery_failed" } }) === 1;
      }
      if (!deliveryFailureClosed) throw new Error("phase6_verification_delivery_failure_not_closed");

      const supersededOperationId = phase6OperationId("g");
      const successorOperationId = phase6OperationId("h");
      await initiateOnly("u32", supersededOperationId, "first-u32@acceptance.invalid");
      await initiateOnly("u32", successorOperationId, "second-u32@acceptance.invalid");
      sql(`SELECT "status" || '|' || "outcomeCode" FROM "GlobalSecurityOperation" WHERE "userId"='u32' AND "operationId"='${supersededOperationId}'`, "rejected|abandoned");
      sql(`SELECT (SELECT "email" FROM "User" WHERE "id"='u25') || '|' || (SELECT "state" FROM "EmailChange" WHERE "userId"='u25') || '|' || (SELECT "cookieState" FROM "EmailChangeSessionRotation" WHERE "userId"='u25') || '|' || (SELECT "status" FROM "Invite" WHERE "id"='phase6-old-invite') || '|' || (SELECT "status" FROM "Invite" WHERE "email"='new-u25@acceptance.invalid')`, "new-u25@acceptance.invalid|completed|confirmed|revoked|pending");
      sql(`SELECT rotation."activityOriginalCreatedAt"=activity."originalCreatedAt" AND activity."originalCreatedAt" < rotation."issuedAt" FROM "EmailChangeSessionRotation" rotation JOIN "SessionSecurityActivity" activity ON activity."sessionId"=rotation."successorSessionId" WHERE rotation."userId"='u25'`, "t");
      console.log("phase7_email_rotation_anchor_retained");
      sql(`SELECT (SELECT "cookieState" FROM "EmailChangeSessionRotation" WHERE "userId"='u26') || '|' || (SELECT count(*) FROM "Session" WHERE "id"='phase6-successor-u26') || '|' || (SELECT "state" FROM "SessionSecurityActivity" WHERE "sessionId"='phase6-successor-u26')`, "failed|0|revoked");
      sql(`SELECT count(*) FROM "Invite" WHERE "id"<>'phase6-old-invite' AND "email"='new-u25@acceptance.invalid' AND "tokenHash" ~ '^sha256:[0-9a-f]{64}$'`, "1");
      const rotatedEmailDeliveryKeyring = `${emailDeliveryKeyring},2:${Buffer.alloc(32, 0x44).toString("base64url")}`;
      run(process.execPath, [resolve(root, "scripts/provision-email-delivery-keys.mjs")], { ...env, DATABASE_URL: databaseUrl, CUBBY_EMAIL_DELIVERY_KEYRING: rotatedEmailDeliveryKeyring, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "2" }, true, "phase6_delivery_key_rotation_failed");
      const missingReferencedKeyEnv = { ...env, DATABASE_URL: databaseUrl, CUBBY_EMAIL_DELIVERY_KEYRING: `2:${Buffer.alloc(32, 0x44).toString("base64url")}`, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "2" };
      const missingReferencedKey = spawnSync(process.execPath, [resolve(root, "scripts/provision-email-delivery-keys.mjs")], { cwd: root, env: missingReferencedKeyEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      if (missingReferencedKey.error || missingReferencedKey.status === 0 || !redact(`${missingReferencedKey.stdout ?? ""}\n${missingReferencedKey.stderr ?? ""}`, missingReferencedKeyEnv).includes("cubby_startup phase=email_delivery_keys status=failed")) throw new Error("phase6_delivery_key_restore_mismatch_not_rejected");
      run(process.execPath, [resolve(root, "scripts/provision-email-delivery-keys.mjs")], { ...env, DATABASE_URL: databaseUrl, CUBBY_EMAIL_DELIVERY_KEYRING: rotatedEmailDeliveryKeyring, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "2" }, true, "phase6_delivery_key_restore_failed");
      rejectSql(`DELETE FROM "EmailDeliveryEncryptionKey" WHERE "keyVersion"=1`, "email_delivery_key_still_referenced");
      await cancelVerifiedEmailChange(phase6Database, { userId: "u32", operationId: successorOperationId, sessionId: "phase6-old-session-u32" });
      const rotatedCipher = createEmailDeliveryCipher({ CUBBY_EMAIL_DELIVERY_KEYRING: rotatedEmailDeliveryKeyring, CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "2" });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const delivery = await dispatchEmailChangeDelivery(phase6DeliveryDatabase, randomBytes(16).toString("base64url"), { cipher: rotatedCipher, smtp: { send: async (payload) => ({ responseCode: 250, messageId: payload.messageId, accepted: [payload.recipient] }) } });
        if (delivery.status === "idle") break;
        if (attempt === 29) throw new Error("phase6_delivery_drain_bound_exceeded");
      }
      sql(`SELECT count(*) FROM "EmailChangeDelivery" WHERE "state" IN ('queued','dispatching','retryable_failed')`, "0");
      sql(`DELETE FROM "EmailDeliveryEncryptionKey" WHERE "keyVersion"=1`);
      sql(`SELECT "keyVersion" || '|' || "activeWrite" || '|' || ("retiredAt" IS NULL) FROM "EmailDeliveryEncryptionKey"`, "2|true|true");
      console.log("phase6_email_change_service_lifecycle_pass");
    } finally {
      await phase6Database.$disconnect();
      await phase6AuthDatabase.$disconnect();
      await phase6DeliveryDatabase.$disconnect();
    }

    const smtpKeyPath = resolve(temporaryRoot, "smtp-key.pem");
    const smtpCertPath = resolve(temporaryRoot, "smtp-cert.pem");
    run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", smtpKeyPath, "-out", smtpCertPath, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], env, false, "phase6_smtp_certificate_generation_failed");
    const smtpUsername = `phase6-${suffix}`;
    const smtpPassword = randomBytes(24).toString("base64url");
    const smtpRecipient = `phase6-${suffix}@acceptance.invalid`;
    const syntheticSmtp = await startSyntheticSmtp({ key: readFileSync(smtpKeyPath), cert: readFileSync(smtpCertPath), username: smtpUsername, password: smtpPassword, recipient: smtpRecipient });
    try {
      const adapter = createSmtpEmailDeliveryAdapter({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(syntheticSmtp.port), SMTP_USER: smtpUsername, SMTP_PASSWORD: smtpPassword, EMAIL_FROM: "Cubby <noreply@acceptance.invalid>", SMTP_CA_CERT: readFileSync(smtpCertPath, "utf8"), SMTP_SECURE: "true" });
      const messageId = "<phase6.synthetic@mail.cubby.local>";
      const receipt = await adapter.send({ recipient: smtpRecipient, subject: "Synthetic acceptance", text: "Content-free delivery acceptance.", messageId });
      if (receipt.responseCode !== 250 || receipt.messageId !== messageId || receipt.accepted.length !== 1 || syntheticSmtp.accepted.length !== 1 || syntheticSmtp.accepted[0]!.messageId !== messageId) throw new Error("phase6_smtp_receipt_invalid");
      console.log("phase6_synthetic_authenticated_tls_smtp_pass");
    } finally {
      await syntheticSmtp.close();
    }
    sql(`INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES
      ('u1','Synthetic User One','u1@acceptance.invalid',true,NOW(),NOW()),
      ('u2','Synthetic User Two','u2@acceptance.invalid',true,NOW(),NOW()),
      ('u3','Synthetic User Three','u3@acceptance.invalid',true,NOW(),NOW()),
      ('u4','Synthetic User Four','u4@acceptance.invalid',true,NOW(),NOW()),
      ('u5','Synthetic User Five','u5@acceptance.invalid',true,NOW(),NOW()),
      ('u6','Synthetic User Six','u6@acceptance.invalid',true,NOW(),NOW()),
      ('u7','Synthetic User Seven','u7@acceptance.invalid',true,NOW(),NOW()),
      ('u8','Synthetic User Eight','u8@acceptance.invalid',true,NOW(),NOW()),
      ('u9','Synthetic User Nine','u9@acceptance.invalid',true,NOW(),NOW()),
      ('u10','Synthetic User Ten','u10@acceptance.invalid',true,NOW(),NOW()),
      ('u11','Synthetic User Eleven','u11@acceptance.invalid',true,NOW(),NOW()),
      ('u14','Synthetic User Fourteen','u14@acceptance.invalid',true,NOW(),NOW()),
      ('u15','Synthetic User Fifteen','u15@acceptance.invalid',true,NOW(),NOW());`);
    seedEmailOperation("u1");
    seedEmailOperation("u2");
    seedEmailOperation("u3");
    sql(`INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u6',1,1,NOW())`);
    seedRecoverySet("u6");
    retireRecoveryIssuanceSession("u6");
    rejectSql(`/* recovery_generated_set_reset_rejected */ UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='recovery_reset',"consumedOperationId"='recovery-generated-reset-u6',"consumedAt"=NOW() WHERE "id"='code-u6-2'`, "recovery_code_consumption_operation_mismatch");
    rejectSql(`/* recovery_set_terminalized_operation_rejected */ BEGIN; INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u12','Synthetic User Twelve','u12@acceptance.invalid',true,NOW(),NOW()); INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u12',1,1,NOW()); INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('session-u12','token-u12',NOW()+INTERVAL '1 day','u12',NOW(),NOW()); INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","sessionSecurityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-u12','u12','session-u12','operation-u12','recovery_enrollment',1,1,'opening-u12','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW()); INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-u12','u12','operation-u12','recovery_enrollment','intent-u12','pending',NOW(),NOW()); UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-u12'; INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('grant-u12','u12','session-u12','operation-u12','recovery_enrollment',1,'issued',NOW()+INTERVAL '10 minutes',NOW()); INSERT INTO "RecoveryCodeSet" ("userId","setVersion","issuanceOperationId","freshAuthGrantId","issuanceSecurityVersion","issuanceSessionSecurityVersion","state","updatedAt") VALUES ('u12',1,'operation-u12','grant-u12',1,1,'generated',NOW()); INSERT INTO "RecoveryCode" ("id","userId","setVersion","ordinal","salt","derivedKey","state","createdAt") SELECT 'code-u12-' || ordinal,'u12',1,ordinal,decode(lpad(to_hex(ordinal),32,'0'),'hex'),decode(lpad(to_hex(ordinal),64,'0'),'hex'),'active',NOW() FROM generate_series(1,10) ordinal; UPDATE "GlobalSecurityOperation" SET "status"='rejected',"outcomeVersion"=1,"outcomeCode"='rehearsal_failed',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u12' AND "operationId"='operation-u12'; UPDATE "GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=NOW() WHERE "id"='binding-u12'; UPDATE "FreshAuthGrant" SET "state"='consumed',"consumedAt"=NOW() WHERE "id"='grant-u12'; COMMIT`, "fresh_auth_grant_operation_not_consumable");
    sql(`/* recovery_grant_database_clock_normalized */ BEGIN; INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u13','Synthetic User Thirteen','u13@acceptance.invalid',true,NOW(),NOW()); INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u13',1,1,NOW()); INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('session-u13','token-u13',NOW()+INTERVAL '1 day','u13',NOW(),NOW()); INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","sessionSecurityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-u13','u13','session-u13','operation-u13','recovery_enrollment',1,1,'opening-u13','{}','open',NOW()+INTERVAL '1 day',NOW()+INTERVAL '1 day',NOW()); INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-u13','u13','operation-u13','recovery_enrollment','intent-u13','pending',NOW(),NOW()); UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-u13'; INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('grant-u13','u13','session-u13','operation-u13','recovery_enrollment',1,'issued',NOW()+INTERVAL '1 day',NOW()+INTERVAL '1 day'); INSERT INTO "RecoveryCodeSet" ("userId","setVersion","issuanceOperationId","freshAuthGrantId","issuanceSecurityVersion","issuanceSessionSecurityVersion","state","updatedAt") VALUES ('u13',1,'operation-u13','grant-u13',1,1,'generated',NOW()); INSERT INTO "RecoveryCode" ("id","userId","setVersion","ordinal","salt","derivedKey","state","createdAt") SELECT 'code-u13-' || ordinal,'u13',1,ordinal,decode(lpad(to_hex(ordinal),32,'0'),'hex'),decode(lpad(to_hex(ordinal),64,'0'),'hex'),'active',NOW() FROM generate_series(1,10) ordinal; UPDATE "FreshAuthGrant" SET "state"='consumed',"consumedAt"=NOW() WHERE "id"='grant-u13'; COMMIT`);
    sql(`SELECT (g."expiresAt"-g."createdAt")=INTERVAL '10 minutes' AND (binding."expiresAt"-binding."createdAt")=INTERVAL '10 minutes' FROM "FreshAuthGrant" g JOIN "GlobalSecurityOperationBinding" binding ON binding."userId"=g."userId" AND binding."operationId"=g."operationId" WHERE g."id"='grant-u13'`, "t");
    sql(`INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('session-u7','token-u7',NOW()+INTERVAL '1 day','u7',NOW(),NOW()); INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u7',1,1,NOW())`);
    sql(`INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('phase2-expiring-session-u7','phase2-expiring-token-u7',NOW()+INTERVAL '5 seconds','u7',NOW(),NOW())`);
    const phase2ExpiryController = startSql(`BEGIN; SELECT "id" FROM "Session" WHERE "id"='phase2-expiring-session-u7' FOR UPDATE; SELECT pg_sleep(6) /* phase2_session_expiry_controller_probe */; COMMIT;`);
    let phase2ExpiryControllerPid = "";
    for (let attempt = 0; attempt < 20 && !phase2ExpiryControllerPid; attempt += 1) {
      phase2ExpiryControllerPid = run("docker", psql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%phase2_session_expiry_controller_probe%' AND state='active' LIMIT 1`), env, true, "phase2_session_expiry_controller_probe_failed");
    }
    if (!phase2ExpiryControllerPid) throw new Error("phase2_session_expiry_controller_pid_missing");
    const phase2ExpiryContender = startSql(`BEGIN; SELECT "id" FROM "Session" WHERE "id"='phase2-expiring-session-u7' AND "userId"='u7' FOR UPDATE /* phase2_session_expiry_contender_probe */; SELECT count(*) FROM "Session" WHERE "id"='phase2-expiring-session-u7' AND "userId"='u7' AND "expiresAt" > clock_timestamp(); COMMIT;`);
    let phase2ExpiryContenderPid = "";
    for (let attempt = 0; attempt < 20 && !phase2ExpiryContenderPid; attempt += 1) {
      phase2ExpiryContenderPid = run("docker", psql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%phase2_session_expiry_contender_probe%' AND state='active' LIMIT 1`), env, true, "phase2_session_expiry_contender_probe_failed");
    }
    if (!phase2ExpiryContenderPid) throw new Error("phase2_session_expiry_contender_pid_missing");
    let phase2ExpiryWaitObserved = false;
    for (let attempt = 0; attempt < 20 && !phase2ExpiryWaitObserved; attempt += 1) {
      phase2ExpiryWaitObserved = run("docker", psql(`SELECT ${phase2ExpiryControllerPid}::integer = ANY(pg_blocking_pids(${phase2ExpiryContenderPid}::integer))`), env, true, "phase2_session_expiry_wait_probe_failed") === "t";
    }
    if (!phase2ExpiryWaitObserved) throw new Error("phase2_session_expiry_wait_not_observed");
    const [phase2ExpiryControllerResult, phase2ExpiryContenderResult] = await Promise.all([phase2ExpiryController.done, phase2ExpiryContender.done]);
    if (phase2ExpiryControllerResult.status !== 0 || phase2ExpiryContenderResult.status !== 0 || !phase2ExpiryContenderResult.output.includes("0")) {
      process.stderr.write(phase2ExpiryContenderResult.output.slice(-12_000));
      throw new Error("phase2_session_expiry_after_lock_wait_not_rejected");
    }
    console.log("phase2_session_expiry_after_lock_wait_rejected");
    sql(`INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-transition-race-u7','u7','session-u7','operation-transition-race-u7','session_revoke',1,'opening-transition-race-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`);
    const transitionController = startSql(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0)); SELECT pg_sleep(15) /* global_security_transition_controller_probe */; COMMIT;`);
    let controllerPid = "";
    for (let attempt = 0; attempt < 20 && !controllerPid; attempt += 1) {
      controllerPid = run("docker", psql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%global_security_transition_controller_probe%' AND state='active' LIMIT 1`), env, true, "global_security_transition_controller_probe_failed");
    }
    if (!controllerPid) throw new Error("global_security_transition_controller_not_observed");
    const transitionContender = startSql(`BEGIN; UPDATE "GlobalSecurityOperationBinding" SET "state"='revoked',"updatedAt"=NOW() WHERE "id"='binding-transition-race-u7' /* global_security_transition_contender_probe */; COMMIT;`);
    let contenderPid = "";
    for (let attempt = 0; attempt < 20 && !contenderPid; attempt += 1) {
      contenderPid = run("docker", psql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%global_security_transition_contender_probe%' AND state='active' LIMIT 1`), env, true, "global_security_transition_contender_probe_failed");
    }
    if (!contenderPid) throw new Error("global_security_transition_contender_pid_missing");
    let transitionWaitObserved = false;
    for (let attempt = 0; attempt < 20 && !transitionWaitObserved; attempt += 1) {
      transitionWaitObserved = run("docker", psql(`SELECT cardinality(pg_blocking_pids(${contenderPid}::integer)) > 0`), env, true, "global_security_transition_wait_probe_failed") === "t";
    }
    if (!transitionWaitObserved) throw new Error("global_security_transition_wait_not_observed");
    console.log("global_security_transition_wait_observed");
    const [transitionControllerResult, transitionContenderResult] = await Promise.all([transitionController.done, transitionContender.done]);
    if (transitionControllerResult.status !== 0 || transitionContenderResult.status !== 0) throw new Error("global_security_transition_race_failed");
    sql(`INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u8',1,1,NOW())`);
    seedRecoverySet("u8");
    retireRecoveryIssuanceSession("u8");
    rehearseRecoverySet("u8");
    retireRecoveryEnrollmentSession("u8");
    sql(`
      INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","createdAt") VALUES ('recovery-session-u8','u8','code-u8-2','recovery-operation-u8','recovery_reset','restricted',NOW()+INTERVAL '10 minutes',NOW());
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-recovery-u8','u8','recovery-session-u8','recovery-operation-u8','recovery_reset',1,'opening-recovery-u8','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-recovery-u8','u8','recovery-operation-u8','recovery_reset','intent-recovery-u8','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-recovery-u8';
      UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='recovery_reset',"consumedOperationId"='recovery-operation-u8',"consumedAt"=NOW() WHERE "id"='code-u8-2';
    `);
    sql(`INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u14',1,1,NOW())`);
    seedRecoverySet("u14");
    retireRecoveryIssuanceSession("u14");
    rehearseRecoverySet("u14");
    retireRecoveryEnrollmentSession("u14");
    sql(`
      INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","createdAt") VALUES ('recovery-session-u14','u14','code-u14-2','recovery-operation-u14','recovery_reset','restricted',NOW()+INTERVAL '10 minutes',NOW());
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-recovery-u14','u14','recovery-session-u14','recovery-operation-u14','recovery_reset',1,'opening-recovery-u14','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-recovery-u14','u14','recovery-operation-u14','recovery_reset','intent-recovery-u14','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-recovery-u14';
      UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='recovery_reset',"consumedOperationId"='recovery-operation-u14',"consumedAt"=NOW() WHERE "id"='code-u14-2';
    `);
    sql(`ALTER TABLE "RecoverySession" DISABLE TRIGGER ALL; UPDATE "RecoverySession" SET "createdAt"=NOW()-INTERVAL '11 minutes',"expiresAt"=NOW()-INTERVAL '1 minute' WHERE "id"='recovery-session-u14'; ALTER TABLE "RecoverySession" ENABLE TRIGGER ALL; SELECT "expire_recovery_session_finalization"('u14','recovery-session-u14')`);
    sql(`SELECT operation."status" || '|' || operation."outcomeCode" || '|' || binding."state" || '|' || recovery."state" FROM "GlobalSecurityOperation" operation JOIN "GlobalSecurityOperationBinding" binding ON binding."id"=operation."bindingId" JOIN "RecoverySession" recovery ON recovery."userId"=operation."userId" AND recovery."operationId"=operation."operationId" WHERE operation."userId"='u14'`, "rejected|recovery_session_expired|terminal|expired");
    console.log("recovery_submitted_expiry_finalized");
    sql(`INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u15',1,1,NOW())`);
    seedRecoverySet("u15");
    retireRecoveryIssuanceSession("u15");
    rehearseRecoverySet("u15");
    retireRecoveryEnrollmentSession("u15");
    sql(`
      INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","createdAt") VALUES ('recovery-session-u15','u15','code-u15-2','recovery-operation-u15','recovery_reset','restricted',NOW()+INTERVAL '10 minutes',NOW());
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-recovery-u15','u15','recovery-session-u15','recovery-operation-u15','recovery_reset',1,'opening-recovery-u15','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-recovery-u15','u15','recovery-operation-u15','recovery_reset','intent-recovery-u15','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-recovery-u15';
      UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='recovery_reset',"consumedOperationId"='recovery-operation-u15',"consumedAt"=NOW() WHERE "id"='code-u15-2';
    `);
    sql(`ALTER TABLE "RecoverySession" DISABLE TRIGGER ALL; UPDATE "RecoverySession" SET "createdAt"=NOW()-INTERVAL '11 minutes',"expiresAt"=NOW()-INTERVAL '1 minute' WHERE "id"='recovery-session-u15'; ALTER TABLE "RecoverySession" ENABLE TRIGGER ALL`);
    rejectSql(`/* recovery_submitted_expiry_partial_rejected */ BEGIN; UPDATE "GlobalSecurityOperation" SET "status"='rejected',"outcomeVersion"=1,"outcomeCode"='recovery_session_expired',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u15' AND "operationId"='recovery-operation-u15'; COMMIT`, "recovery_session_expiry_finalization_required");
    console.log("recovery_submitted_expiry_partial_rejected");
    sql(`
      ALTER TABLE "RecoverySession" DISABLE TRIGGER ALL;
      INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","consumedAt","closedAt","createdAt") VALUES
        ('recovery-wrong-purpose-u7','u7','carrier-code-wrong-purpose-u7','carrier-operation-wrong-purpose-u7','password_change','restricted',NOW()+INTERVAL '10 minutes',NULL,NULL,NOW()),
        ('recovery-consumed-u7','u7','carrier-code-consumed-u7','carrier-operation-consumed-u7','recovery_reset','consumed',NOW()+INTERVAL '10 minutes',NOW(),NULL,NOW()),
        ('recovery-closed-u7','u7','carrier-code-closed-u7','carrier-operation-closed-u7','recovery_reset','closed',NOW()+INTERVAL '10 minutes',NULL,NOW(),NOW()),
        ('recovery-expired-u7','u7','carrier-code-expired-u7','carrier-operation-expired-u7','recovery_reset','restricted',NOW()-INTERVAL '1 second',NULL,NULL,NOW()-INTERVAL '10 minutes');
      ALTER TABLE "RecoverySession" ENABLE TRIGGER ALL;
    `);
    rejectRecoveryCarrier("recovery_carrier_missing", `INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-carrier-missing-u7','u7','recovery-missing-u7','carrier-operation-missing-u7','recovery_reset',1,'opening-carrier-missing-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_recovery_binding_authorization_required");
    rejectRecoveryCarrier("recovery_carrier_foreign_user", `INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-carrier-foreign-u7','u7','recovery-session-u8','recovery-operation-u8','recovery_reset',1,'opening-carrier-foreign-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_recovery_binding_authorization_required");
    rejectRecoveryCarrier("recovery_carrier_operation_mismatch", `INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-carrier-mismatch-u8','u8','recovery-session-u8','recovery-operation-mismatch-u8','recovery_reset',1,'opening-carrier-mismatch-u8','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_recovery_binding_authorization_required");
    rejectRecoveryCarrier("recovery_carrier_wrong_purpose", `INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-carrier-wrong-purpose-u7','u7','recovery-wrong-purpose-u7','carrier-operation-wrong-purpose-u7','recovery_reset',1,'opening-carrier-wrong-purpose-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_recovery_binding_authorization_required");
    rejectRecoveryCarrier("recovery_carrier_consumed", `INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-carrier-consumed-u7','u7','recovery-consumed-u7','carrier-operation-consumed-u7','recovery_reset',1,'opening-carrier-consumed-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_recovery_binding_authorization_required");
    rejectRecoveryCarrier("recovery_carrier_closed", `INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-carrier-closed-u7','u7','recovery-closed-u7','carrier-operation-closed-u7','recovery_reset',1,'opening-carrier-closed-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_recovery_binding_authorization_required");
    rejectRecoveryCarrier("recovery_carrier_expired", `INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-carrier-expired-u7','u7','recovery-expired-u7','carrier-operation-expired-u7','recovery_reset',1,'opening-carrier-expired-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_recovery_binding_authorization_required");
    rejectRecoveryCarrier("recovery_carrier_non_recovery_operation", `INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-carrier-password-u8','u8','recovery-session-u8','recovery-operation-u8','password_change',1,'opening-carrier-password-u8','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_binding_initial_state_invalid");
    rejectRecoveryCarrier("ordinary_session_recovery_reset", `INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-ordinary-recovery-u7','u7','session-u7','ordinary-recovery-operation-u7','recovery_reset',1,'opening-ordinary-recovery-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_recovery_binding_authorization_required");
    sql(`
      UPDATE "GlobalSecurityOperation" SET "status"='unknown',"updatedAt"=NOW() WHERE "userId"='u8' AND "operationId"='recovery-operation-u8';
      UPDATE "GlobalSecurityOperation" SET "status"='rejected',"outcomeVersion"=1,"outcomeCode"='recovery_set_regenerated',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u8' AND "operationId"='recovery-operation-u8';
      UPDATE "GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=NOW() WHERE "id"='binding-recovery-u8';
      UPDATE "RecoverySession" SET "state"='closed',"closedAt"=NOW() WHERE "id"='recovery-session-u8';
      INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('event-regenerated-u8','u8','operation_outcome','rejected','recovery-operation-u8','{}',NOW());
    `);
    rejectSql(`/* phase1_terminal_tombstone_insert_rejected */ INSERT INTO "GlobalSecurityOperationTombstone" ("userId","operationId","operationKey","intentFingerprint","terminalStatus","terminalCode","terminalAt","compactedAt") SELECT "userId","operationId","operationKey","intentFingerprint","status","outcomeCode","terminalAt",NOW() FROM "GlobalSecurityOperation" WHERE "userId"='u8' AND "operationId"='recovery-operation-u8'`, "global_security_tombstone_insert_not_enabled");
    sql(`SELECT 'recovery_carrier_valid_replay' || '|' || (SELECT COUNT(*) FROM "Session" WHERE "userId"='u8') || '|' || operation."status" || '|' || operation."outcomeCode" || '|' || recovery."state" FROM "GlobalSecurityOperation" operation JOIN "RecoverySession" recovery ON recovery."userId"=operation."userId" AND recovery."operationId"=operation."operationId" WHERE operation."userId"='u8' AND operation."operationId"='recovery-operation-u8'`, "recovery_carrier_valid_replay|0|rejected|recovery_set_regenerated|closed");
    sql(`INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u10',1,1,NOW())`);
    seedRecoverySet("u10");
    retireRecoveryIssuanceSession("u10");
    rehearseRecoverySet("u10");
    retireRecoveryEnrollmentSession("u10");
    sql(`
      INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES
        ('session-u9','token-u9',NOW()+INTERVAL '1 day','u9',NOW(),NOW()),
        ('session-u11','token-u11',NOW()+INTERVAL '1 day','u11',NOW(),NOW());
      INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u9',1,1,NOW()),('u11',1,1,NOW());

      INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","createdAt") VALUES ('recovery-session-u10','u10','code-u10-2','stale-recovery-operation-u10','recovery_reset','restricted',NOW()+INTERVAL '10 minutes',NOW());

      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES
        ('binding-stale-password-u9','u9','session-u9','stale-password-operation-u9','password_change',1,'opening-stale-password-u9','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW()),
        ('binding-stale-session-u11','u11','session-u11','stale-session-operation-u11','session_revoke',1,'opening-stale-session-u11','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-stale-recovery-u10','u10','recovery-session-u10','stale-recovery-operation-u10','recovery_reset',1,'opening-stale-recovery-u10','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES
        ('binding-stale-password-u9','u9','stale-password-operation-u9','password_change','intent-stale-password-u9','pending',NOW(),NOW()),
        ('binding-stale-recovery-u10','u10','stale-recovery-operation-u10','recovery_reset','intent-stale-recovery-u10','pending',NOW(),NOW()),
        ('binding-stale-session-u11','u11','stale-session-operation-u11','session_revoke','intent-stale-session-u11','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id" IN ('binding-stale-password-u9','binding-stale-recovery-u10','binding-stale-session-u11');
      UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='recovery_reset',"consumedOperationId"='stale-recovery-operation-u10',"consumedAt"=NOW() WHERE "id"='code-u10-2';
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-stale-current-u7','u7','session-u7','stale-current-operation-u7','password_change',1,'opening-stale-current-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-stale-current-u7','u7','stale-current-operation-u7','password_change','intent-stale-current-u7','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-stale-current-u7';
    `);
    rejectSql(`/* stale_security_version_current_version_rejected */ UPDATE "GlobalSecurityOperation" SET "status"='stale',"outcomeVersion"=1,"outcomeCode"='stale_security_version',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u7' AND "operationId"='stale-current-operation-u7'`, "global_security_stale_finalization_invalid");
    sql(`UPDATE "AccountSecurityState" SET "credentialVersion"=2,"lastCredentialOperationId"='independent-version-change-' || "userId","securityUpdatedAt"=NOW() WHERE "userId" IN ('u9','u10'); UPDATE "AccountSecurityState" SET "sessionSecurityVersion"=2,"lastSessionSecurityOperationId"='independent-session-version-change-u11',"securityUpdatedAt"=NOW() WHERE "userId"='u11'`);
    rejectSql(`/* stale_security_version_nonmatching_outcome_rejected */ UPDATE "GlobalSecurityOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeCode"='stale_security_version',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u9' AND "operationId"='stale-password-operation-u9'`, "global_security_success_finalization_not_enabled");
    rejectSql(`/* phase1_mutate_then_stale_rejected */ BEGIN; UPDATE "AccountSecurityState" SET "credentialVersion"="credentialVersion"+1,"lastCredentialOperationId"='stale-password-operation-u9',"securityUpdatedAt"=NOW() WHERE "userId"='u9'; UPDATE "GlobalSecurityOperation" SET "status"='stale',"outcomeVersion"=1,"outcomeCode"='stale_security_version',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u9' AND "operationId"='stale-password-operation-u9'; COMMIT`, "global_security_stale_finalization_invalid");
    sql(`
      UPDATE "GlobalSecurityOperation" SET "status"='stale',"outcomeVersion"=1,"outcomeCode"='stale_security_version',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE ("userId","operationId") IN (('u9','stale-password-operation-u9'),('u10','stale-recovery-operation-u10'),('u11','stale-session-operation-u11'));
      UPDATE "GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=NOW() WHERE "id" IN ('binding-stale-password-u9','binding-stale-recovery-u10','binding-stale-session-u11');
      UPDATE "RecoverySession" SET "state"='closed',"closedAt"=NOW() WHERE "id"='recovery-session-u10';
      INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('event-stale-password-u9','u9','operation_outcome','stale_security_version','stale-password-operation-u9','{}',NOW()),('event-stale-recovery-u10','u10','operation_outcome','stale_security_version','stale-recovery-operation-u10','{}',NOW()),('event-stale-session-u11','u11','operation_outcome','stale_security_version','stale-session-operation-u11','{}',NOW());
    `);
    sql(`SELECT 'stale_security_version_password_finalization|' || "status" || '|' || "outcomeCode" FROM "GlobalSecurityOperation" WHERE "userId"='u9' AND "operationId"='stale-password-operation-u9'`, "stale_security_version_password_finalization|stale|stale_security_version");
    sql(`SELECT 'stale_security_version_recovery_finalization|' || operation."status" || '|' || operation."outcomeCode" || '|' || recovery."state" FROM "GlobalSecurityOperation" operation JOIN "RecoverySession" recovery ON recovery."userId"=operation."userId" AND recovery."operationId"=operation."operationId" WHERE operation."userId"='u10' AND operation."operationId"='stale-recovery-operation-u10'`, "stale_security_version_recovery_finalization|stale|stale_security_version|closed");
    sql(`SELECT 'session_security_version_only_stale_finalization|' || "status" || '|' || "outcomeCode" FROM "GlobalSecurityOperation" WHERE "userId"='u11' AND "operationId"='stale-session-operation-u11'`, "session_security_version_only_stale_finalization|stale|stale_security_version");
    sql(`SELECT 'stale_security_version_protected_state_unchanged|' || string_agg("credentialVersion"::text || ':' || "sessionSecurityVersion"::text,',' ORDER BY "userId") || '|' || (SELECT COUNT(*) FROM "Session" WHERE "userId" IN ('u9','u10','u11')) FROM "AccountSecurityState" WHERE "userId" IN ('u9','u10','u11')`, "stale_security_version_protected_state_unchanged|2:1,1:2,2:1|2");
    rejectSql(`INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-forged-expired-u7','u7','session-u7','operation-forged-expired-u7','session_revoke',1,'opening-forged-expired-u7','{}','expired',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_binding_initial_state_invalid");
    rejectSql(`INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-stale-version-u7','u7','session-u7','operation-stale-version-u7','session_revoke',2,'opening-stale-version-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_binding_initial_state_invalid");
    sql(`INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('session-expired-u7','token-expired-u7',NOW()-INTERVAL '1 second','u7',NOW()-INTERVAL '1 day',NOW());`);
    rejectSql(`INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-expired-session-u7','u7','session-expired-u7','operation-expired-session-u7','session_revoke',1,'opening-expired-session-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`, "global_security_binding_initial_state_invalid");
    sql(`INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-open-u7','u7','session-u7','operation-open-u7','email_change',1,'opening-open-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`);
    rejectSql(`INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","outcomeVersion","outcomeCode","outcomeSnapshot","terminalAt","createdAt","updatedAt") VALUES ('binding-open-u7','u7','operation-open-u7','email_change','intent-open-u7','completed',1,'forged','{}',NOW(),NOW(),NOW())`, "global_security_operation_initial_state_invalid");
    sql(`INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-open-u7','u7','operation-open-u7','email_change','intent-open-u7','pending',NOW(),NOW())`);
    rejectSql(`/* fresh_auth_cross_purpose_rejected */ INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('grant-cross-purpose-u7','u7','session-u7','operation-open-u7','password_change',1,'issued',NOW()+INTERVAL '10 minutes',NOW())`, "fresh_auth_grant_purpose_operation_mismatch");
    sql(`INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('grant-u7','u7','session-u7','operation-open-u7','email_change',1,'issued',NOW()+INTERVAL '10 minutes',NOW()); UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-open-u7'`);
    rejectSql(`/* recovery_set_wrong_grant_rejected */ INSERT INTO "RecoveryCodeSet" ("userId","setVersion","issuanceOperationId","freshAuthGrantId","issuanceSecurityVersion","issuanceSessionSecurityVersion","state","updatedAt") VALUES ('u7',1,'operation-open-u7','grant-u7',1,1,'generated',NOW())`, "recovery_code_set_issuance_authorization_required");
    rejectSql(`UPDATE "GlobalSecurityOperationBinding" SET "state"='expired',"updatedAt"=NOW() WHERE "id"='binding-open-u7'`, "global_security_binding_invalid_transition");
    rejectSql(`INSERT INTO "EmailChange" ("id","userId","operationId","freshAuthGrantId","securityVersion","normalizedNewEmail","verificationDigest","state","expiresAt","createdAt","updatedAt") VALUES ('email-change-open-u7','u7','operation-email-mismatch-u7','grant-u7',1,'new-u7@acceptance.invalid','digest-u7','pending',NOW()+INTERVAL '1 hour',NOW(),NOW())`, "email_change_fresh_grant_operation_mismatch");
    rejectSql(`INSERT INTO "GlobalSecurityOperationReservationTombstone" ("userId","operationId","operationKey","sessionId","openingFingerprint","terminalCode","terminalAt","compactedAt") VALUES ('u7','operation-open-u7','email_change','session-u7','opening-open-u7','reservation_expired',NOW(),NOW())`, "global_security_reservation_tombstone_insert_not_enabled");

    seedRecoverySet("u1");
    retireRecoveryIssuanceSession("u1");
    rehearseRecoverySet("u1");
    retireRecoveryEnrollmentSession("u1");
    rejectSql(`/* recovery_set_reused_grant_rejected */ INSERT INTO "RecoveryCodeSet" ("userId","setVersion","issuanceOperationId","freshAuthGrantId","issuanceSecurityVersion","issuanceSessionSecurityVersion","state","updatedAt") VALUES ('u1',2,'recovery-issue-operation-u1','recovery-issue-grant-u1',1,1,'generated',NOW())`, "recovery_code_set_issuance_authorization_required");
    rejectSql(`/* recovery_consumption_missing_operation_rejected */ BEGIN; UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='recovery_reset',"consumedOperationId"='recovery-missing-operation-u1',"consumedAt"=NOW() WHERE "id"='code-u1-2'; COMMIT`, "recovery_code_consumption_binding_mismatch");
    rejectSql(`/* recovery_ttl_mismatch_rejected */ BEGIN; INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","createdAt") VALUES ('recovery-ttl-u1','u1','code-u1-2','recovery-ttl-u1','recovery_reset','restricted',NOW()+INTERVAL '9 minutes',NOW()); COMMIT`, "recovery_session_consumption_binding_mismatch");
    rejectSql(`/* recovery_consumption_missing_carrier_rejected */ BEGIN; ALTER TABLE "GlobalSecurityOperationBinding" DISABLE TRIGGER ALL; ALTER TABLE "GlobalSecurityOperation" DISABLE TRIGGER ALL; INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-missing-carrier-u1','u1','missing-carrier-u1','recovery-missing-carrier-u1','recovery_reset',1,'opening-missing-carrier-u1','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW()); INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-missing-carrier-u1','u1','recovery-missing-carrier-u1','recovery_reset','intent-missing-carrier-u1','pending',NOW(),NOW()); UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-missing-carrier-u1'; ALTER TABLE "GlobalSecurityOperation" ENABLE TRIGGER ALL; ALTER TABLE "GlobalSecurityOperationBinding" ENABLE TRIGGER ALL; UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='recovery_reset',"consumedOperationId"='recovery-missing-carrier-u1',"consumedAt"=NOW() WHERE "id"='code-u1-3'; COMMIT`, "recovery_code_consumption_binding_mismatch");
    rejectSql(`/* recovery_wrong_purpose_rejected */ BEGIN; INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","createdAt") VALUES ('recovery-purpose-u1','u1','code-u1-4','recovery-purpose-u1','password_change','restricted',NOW()+INTERVAL '10 minutes',NOW()); COMMIT`, "recovery_session_initial_state_invalid");
    rejectSql(`INSERT INTO "RecoveryCode" ("id","userId","setVersion","ordinal","salt","derivedKey","state","createdAt") VALUES ('code-set2-u1','u1',2,1,decode(repeat('09',16),'hex'),decode(repeat('0a',32),'hex'),'active',NOW())`, "RecoveryCode_userId_setVersion_fkey");
    rejectSql(`INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","createdAt") VALUES ('recovery-active-misuse-u1','u1','code-u1-5','recovery-active-operation-u1','recovery_reset','restricted',NOW()+INTERVAL '10 minutes',NOW())`, "recovery_session_consumption_binding_mismatch");
    await observeTransitionWait("global_security_operation", `UPDATE "GlobalSecurityOperation" SET "status"='rejected',"outcomeVersion"=1,"outcomeCode"='verification_expired',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u1' AND "operationId"='operation-email-u1'`);
    await observeTransitionWait("fresh_auth_grant", `UPDATE "FreshAuthGrant" SET "state"='consumed',"consumedAt"=NOW() WHERE "id"='grant-u1'`, "fresh_auth_grant_operation_not_consumable");
    await observeTransitionWait("recovery_code_set", `INSERT INTO "RecoveryCodeSet" ("userId","setVersion","issuanceOperationId","freshAuthGrantId","issuanceSecurityVersion","issuanceSessionSecurityVersion","state","updatedAt") VALUES ('u1',2,'recovery-issue-operation-u1','recovery-issue-grant-u1',1,1,'generated',NOW())`, "recovery_code_set_issuance_authorization_required");
    await observeTransitionWait("recovery_code", `UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='recovery_reset',"consumedOperationId"='recovery-code-race-u8',"consumedAt"=NOW() WHERE "id"='code-u8-3'`, "recovery_code_consumption_binding_mismatch");
    await observeTransitionWait("recovery_session", `UPDATE "RecoverySession" SET "state"='expired' WHERE "id"='recovery-session-u8'`, "recovery_session_invalid_transition");
    await observeTransitionWait("recovery_session_insert", `INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","createdAt") VALUES ('recovery-insert-race-u1','u1','code-u1-5','recovery-insert-race-u1','recovery_reset','restricted',NOW()+INTERVAL '10 minutes',NOW())`, "recovery_session_consumption_binding_mismatch");
    await observeTransitionWait("email_change", `UPDATE "EmailChange" SET "state"='verified',"updatedAt"=NOW() WHERE "id"='email-change-u2'`, "email_change_runtime_transition_forbidden");
    await observeTransitionWait("global_security_operation_insert", `INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('missing-binding-insert-u7','u7','operation-insert-missing-u7','session_revoke','intent-insert-missing-u7','pending',NOW(),NOW())`, "global_security_operation_binding_mismatch");
    await observeTransitionWait("global_security_binding_insert", `INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-insert-u7','u7','session-u7','operation-insert-u7','session_revoke',1,'opening-insert-u7','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW())`);
    await observeTransitionWait("fresh_auth_grant_insert", `INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('grant-insert-u7','u7','session-u7','operation-insert-missing-u7','session_revoke',1,'issued',NOW()+INTERVAL '10 minutes',NOW())`, "fresh_auth_grant_operation_binding_mismatch");
    await observeTransitionWait("email_change_insert", `INSERT INTO "EmailChange" ("id","userId","operationId","freshAuthGrantId","securityVersion","normalizedNewEmail","verificationDigest","state","expiresAt","createdAt","updatedAt") VALUES ('email-insert-u7','u7','operation-insert-missing-u7','grant-insert-missing-u7',1,'new-insert-u7@acceptance.invalid','digest-insert-u7','pending',NOW()+INTERVAL '1 hour',NOW(),NOW())`, "email_change_fresh_grant_operation_mismatch");
    sql(`INSERT INTO "Account" ("id","accountId","providerId","userId","createdAt","updatedAt") VALUES ('credential-account-u7','credential-u7','credential','u7',NOW(),NOW())`);
    rejectSql(`/* duplicate_credential_account_rejected */ INSERT INTO "Account" ("id","accountId","providerId","userId","createdAt","updatedAt") VALUES ('credential-account-duplicate-u7','credential-duplicate-u7','credential','u7',NOW(),NOW())`, "Account_one_credential_per_user");
    sql(`UPDATE "AccountSecurityState" SET "sessionSecurityVersion"=2,"lastSessionSecurityOperationId"='fresh-auth-session-vector-probe-u7',"securityUpdatedAt"=NOW() WHERE "userId"='u7'`);
    rejectSql(`/* fresh_auth_session_security_version_rejected */ UPDATE "FreshAuthGrant" SET "state"='consumed',"consumedAt"=NOW() WHERE "id"='grant-u7'`, "fresh_auth_grant_session_security_version_invalid");
    sql(`BEGIN;
      INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u16','Synthetic User Sixteen','u16@acceptance.invalid',true,NOW(),NOW());
      INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u16',1,1,NOW());
      INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('session-u16','token-u16',NOW()+INTERVAL '1 day','u16',NOW(),NOW());
      INSERT INTO "SessionSecurityActivity" ("sessionId","userId","issuanceSessionSecurityVersion","originalCreatedAt","lastQualifyingAt","state","updatedAt") SELECT session_row."id",session_row."userId",state_row."sessionSecurityVersion",session_row."createdAt",session_row."createdAt",'active',NOW() FROM "Session" session_row JOIN "AccountSecurityState" state_row ON state_row."userId"=session_row."userId" WHERE session_row."id"='session-u16';
      INSERT INTO "Account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('credential-account-u16','credential-u16','credential','u16','phase4-old-hash',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","sessionSecurityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-password-u16','u16','session-u16','operation-password-u16','password_change',1,1,'opening-password-u16','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-password-u16','u16','operation-password-u16','password_change','intent-password-u16','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-password-u16';
      INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('grant-password-u16','u16','session-u16','operation-password-u16','password_change',1,'issued',NOW()+INTERVAL '10 minutes',NOW());
      UPDATE "FreshAuthGrant" SET "state"='consumed',"consumedAt"=NOW() WHERE "id"='grant-password-u16';
      UPDATE "AccountSecurityState" SET "credentialVersion"=2,"sessionSecurityVersion"=2,"lastCredentialOperationId"='operation-password-u16',"lastSessionSecurityOperationId"='operation-password-u16',"securityUpdatedAt"=NOW() WHERE "userId"='u16';
      SELECT "apply_password_change_credential_mutation"('u16','operation-password-u16','credential-account-u16','phase4-new-hash');
      DELETE FROM "Session" WHERE "userId"='u16';
      UPDATE "SessionSecurityActivity" SET "state"='revoked',"updatedAt"=NOW() WHERE "userId"='u16' AND "state"='active';
      UPDATE "GlobalSecurityOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeCode"='changed',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u16' AND "operationId"='operation-password-u16';
      UPDATE "GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=NOW() WHERE "id"='binding-password-u16';
      INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('event-password-u16','u16','operation_outcome','completed','operation-password-u16','{}',NOW());
      COMMIT;`);
    console.log("phase4_password_change_atomic_finalization_pass");
    sql(`SELECT 'phase4_password_change_activity_retained|' || "state" FROM "SessionSecurityActivity" WHERE "sessionId"='session-u16'`, "phase4_password_change_activity_retained|revoked");
    runtimeSql(`SELECT has_function_privilege(current_user, '"apply_password_change_credential_mutation"(text,text,text,text)', 'EXECUTE')`, "t");
    runtimeSql(`SELECT has_function_privilege(current_user, '"apply_recovery_reset_credential_mutation"(text,text,text,text)', 'EXECUTE')`, "t");
    rejectRuntimeSql(`/* phase4_runtime_standalone_password_update_rejected */ UPDATE "Account" SET "password"='forged-hash',"updatedAt"=NOW() WHERE "id"='credential-account-u16'`, "permission denied");
    rejectRuntimeSql(`/* phase4_runtime_password_account_insert_rejected */ INSERT INTO "Account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('credential-account-forged-u16','credential-forged-u16','credential','u16','forged-hash',NOW(),NOW())`, "permission denied");
    rejectRuntimeSql(`/* phase4_runtime_forged_credential_receipt_rejected */ SELECT set_config('cubby.password_change_account_update','operation-password-u16',true); INSERT INTO "PasswordChangeCredentialMutation" ("userId","operationId","accountId") VALUES ('u16','operation-password-u16','credential-account-u16')`, "permission denied");
    rejectRuntimeSql(`/* phase5_runtime_forged_recovery_receipt_rejected */ INSERT INTO "RecoveryResetCredentialMutation" ("userId","operationId","accountId") VALUES ('u16','operation-password-u16','credential-account-u16')`, "permission denied");
    rejectSql(`/* phase4_password_change_partial_rejected */ BEGIN;
      INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u17','Synthetic User Seventeen','u17@acceptance.invalid',true,NOW(),NOW());
      INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u17',1,1,NOW());
      INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('session-u17','token-u17',NOW()+INTERVAL '1 day','u17',NOW(),NOW());
      INSERT INTO "Account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('credential-account-u17','credential-u17','credential','u17','phase4-hash',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","sessionSecurityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-password-u17','u17','session-u17','operation-password-u17','password_change',1,1,'opening-password-u17','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-password-u17','u17','operation-password-u17','password_change','intent-password-u17','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-password-u17';
      INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('grant-password-u17','u17','session-u17','operation-password-u17','password_change',1,'issued',NOW()+INTERVAL '10 minutes',NOW());
      UPDATE "FreshAuthGrant" SET "state"='consumed',"consumedAt"=NOW() WHERE "id"='grant-password-u17';
      UPDATE "AccountSecurityState" SET "credentialVersion"=2,"sessionSecurityVersion"=2,"lastCredentialOperationId"='operation-password-u17',"lastSessionSecurityOperationId"='operation-password-u17',"securityUpdatedAt"=NOW() WHERE "userId"='u17';
      UPDATE "GlobalSecurityOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeCode"='changed',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u17' AND "operationId"='operation-password-u17';
      UPDATE "GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=NOW() WHERE "id"='binding-password-u17';
      INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('event-password-u17','u17','operation_outcome','completed','operation-password-u17','{}',NOW());
      COMMIT`, "password_change_success_finalization_required");
    sql(`BEGIN;
      INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u18','Synthetic User Eighteen','u18@acceptance.invalid',true,NOW(),NOW());
      INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u18',1,1,NOW());
      INSERT INTO "Session" ("id","token","expiresAt","userId","createdAt","updatedAt") VALUES ('session-u18','token-u18',NOW()+INTERVAL '1 day','u18',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","sessionSecurityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-password-u18','u18','session-u18','operation-password-u18','password_change',1,1,'opening-password-u18','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-password-u18','u18','operation-password-u18','password_change','intent-password-u18','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-password-u18';
      INSERT INTO "FreshAuthGrant" ("id","userId","sessionId","operationId","purpose","credentialVersion","state","expiresAt","createdAt") VALUES ('grant-password-u18','u18','session-u18','operation-password-u18','password_change',1,'issued',NOW()+INTERVAL '10 minutes',NOW());
      UPDATE "AccountSecurityState" SET "credentialVersion"=2,"lastCredentialOperationId"='independent-version-change-u18',"securityUpdatedAt"=NOW() WHERE "userId"='u18';
      UPDATE "FreshAuthGrant" SET "state"='revoked',"revokedAt"=NOW() WHERE "id"='grant-password-u18';
      UPDATE "GlobalSecurityOperation" SET "status"='stale',"outcomeVersion"=1,"outcomeCode"='stale_security_version',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u18' AND "operationId"='operation-password-u18';
      UPDATE "GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=NOW() WHERE "id"='binding-password-u18';
      INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('event-stale-password-u18','u18','operation_outcome','stale_security_version','operation-password-u18','{}',NOW());
      COMMIT;`);
    console.log("phase4_password_change_stale_finalization_pass");

    const recoveryController = startSql(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('global-security-transition:v1',0)); SELECT pg_sleep(15) /* recovery_controller_probe */; COMMIT;`);
    let recoveryControllerPid = "";
    for (let attempt = 0; attempt < 20 && !recoveryControllerPid; attempt += 1) {
      recoveryControllerPid = run("docker", psql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%recovery_controller_probe%' AND state='active' LIMIT 1`), env, true, "recovery_controller_probe_failed");
    }
    if (!recoveryControllerPid) throw new Error("recovery_controller_pid_missing");
    const recoveryContender = startSql(`INSERT INTO "RecoveryCode" ("id","userId","setVersion","ordinal","salt","derivedKey","state","createdAt") VALUES ('code-race-set2-u6','u6',2,1,decode(repeat('0d',16),'hex'),decode(repeat('0e',32),'hex'),'active',NOW()) /* recovery_contender_probe */`);
    let recoveryContenderPid = "";
    for (let attempt = 0; attempt < 20 && !recoveryContenderPid; attempt += 1) {
      recoveryContenderPid = run("docker", psql(`SELECT pid FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND query LIKE '%recovery_contender_probe%' AND state='active' LIMIT 1`), env, true, "recovery_contender_probe_failed");
    }
    if (!recoveryContenderPid) throw new Error("recovery_contender_pid_missing");
    let recoveryTransitionWaitObserved = false;
    for (let attempt = 0; attempt < 20 && !recoveryTransitionWaitObserved; attempt += 1) {
      recoveryTransitionWaitObserved = run("docker", psql(`SELECT ${recoveryControllerPid}::integer = ANY(pg_blocking_pids(${recoveryContenderPid}::integer))`), env, true, "recovery_transition_wait_probe_failed") === "t";
    }
    if (!recoveryTransitionWaitObserved) throw new Error("recovery_transition_wait_not_observed");
    console.log("recovery_transition_wait_observed");
    const [controllerResult, contenderResult] = await Promise.all([recoveryController.done, recoveryContender.done]);
    if (controllerResult.status !== 0) throw new Error("p1_3_phase1_recovery_race_controller_failed");
    if (contenderResult.status === 0 || !contenderResult.output.includes("RecoveryCode_userId_setVersion_fkey")) {
      process.stderr.write(contenderResult.output.slice(-12_000));
      throw new Error("p1_3_phase1_recovery_race_not_serialized");
    }

    sql(`
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-terminal-u1','u1','session-u1','operation-terminal-u1','password_change',1,'opening-terminal-u1','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-terminal-u1','u1','operation-terminal-u1','password_change','intent-terminal-u1','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-terminal-u1';
    `);
    rejectSql(`/* phase1_forged_success_rejected */ UPDATE "GlobalSecurityOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeCode"='forged',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u1' AND "operationId"='operation-terminal-u1'`, "global_security_success_finalization_not_enabled");
    sql(`
      UPDATE "GlobalSecurityOperation" SET "status"='rejected',"outcomeVersion"=1,"outcomeCode"='operation_conflict',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u1' AND "operationId"='operation-terminal-u1';
      UPDATE "GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=NOW() WHERE "id"='binding-terminal-u1';
    `);
    rejectSql(`/* phase1_terminal_tombstone_insert_rejected */ INSERT INTO "GlobalSecurityOperationTombstone" ("userId","operationId","operationKey","intentFingerprint","terminalStatus","terminalCode","terminalAt","compactedAt") SELECT "userId","operationId","operationKey","intentFingerprint","status","outcomeCode","terminalAt",NOW() FROM "GlobalSecurityOperation" WHERE "userId"='u1' AND "operationId"='operation-terminal-u1'`, "global_security_tombstone_insert_not_enabled");
    sql(`INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","sessionId","operationId","operationKey","securityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-expired-u1','u1','session-u1','operation-expired-u1','session_revoke',1,'opening-expired-u1','{}','open',NOW()+INTERVAL '1 second',NOW(),NOW())`);
    sql(`ALTER TABLE "GlobalSecurityOperationBinding" DISABLE TRIGGER ALL; UPDATE "GlobalSecurityOperationBinding" SET "createdAt"=NOW()-INTERVAL '11 minutes',"expiresAt"=NOW()-INTERVAL '1 minute' WHERE "id"='binding-expired-u1'; ALTER TABLE "GlobalSecurityOperationBinding" ENABLE TRIGGER ALL`);
    sql(`UPDATE "GlobalSecurityOperationBinding" SET "state"='expired',"updatedAt"=NOW() WHERE "id"='binding-expired-u1'`);
    rejectSql(`/* phase1_reservation_tombstone_insert_rejected */ INSERT INTO "GlobalSecurityOperationReservationTombstone" ("userId","operationId","operationKey","sessionId","openingFingerprint","terminalCode","terminalAt","compactedAt") VALUES ('u1','operation-expired-u1','session_revoke','session-u1','opening-expired-u1','reservation_expired',NOW(),NOW())`, "global_security_reservation_tombstone_insert_not_enabled");
    rejectSql(`/* private_event_secret_projection_rejected */ INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('event-secret-u1','u1','operation_outcome','rejected','operation-terminal-u1','{"password":"forbidden"}',NOW())`, "global_security_event_insert_invalid");
    rejectSql(`/* private_event_unknown_type_rejected */ INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('event-unknown-u1','u1','unknown','rejected','operation-terminal-u1','{}',NOW())`, "global_security_event_insert_invalid");
    rejectSql(`/* account_incident_without_user_rejected */ INSERT INTO "GlobalSecurityIncident" ("id","layer","normalizedKey","windowStartedAt","failureCount","state","lastOutcomeAt","createdAt") VALUES ('incident-owner-missing','account_identifier','owner-missing',date_trunc('minute',NOW()),1,'active',NOW(),NOW())`, "global_security_incident_layer_owner_invalid");
    rejectSql(`/* neutral_incident_with_user_rejected */ INSERT INTO "GlobalSecurityIncident" ("id","userId","layer","normalizedKey","windowStartedAt","failureCount","state","lastOutcomeAt","createdAt") VALUES ('incident-neutral-owned','u1','client','neutral-owned',date_trunc('minute',NOW()),1,'active',NOW(),NOW())`, "global_security_incident_layer_owner_invalid");
    sql(`
      INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('event-u1','u1','operation_outcome','rejected','operation-terminal-u1','{}',NOW());
      INSERT INTO "GlobalSecurityIncident" ("id","userId","layer","normalizedKey","windowStartedAt","failureCount","state","lastOutcomeAt","createdAt") VALUES ('incident-u1','u1','account_identifier','AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',date_trunc('minute',NOW()),1,'active',NOW(),NOW());
      INSERT INTO "SessionSecurityActivity" ("sessionId","userId","issuanceSessionSecurityVersion","originalCreatedAt","lastQualifyingAt","state","updatedAt") SELECT session_row."id",session_row."userId",state_row."sessionSecurityVersion",session_row."createdAt",session_row."createdAt",'active',NOW() FROM "Session" session_row JOIN "AccountSecurityState" state_row ON state_row."userId"=session_row."userId" WHERE session_row."id"='session-u1';
    `);
    rejectSql(`INSERT INTO "SessionSecurityActivity" ("sessionId","userId","issuanceSessionSecurityVersion","originalCreatedAt","lastQualifyingAt","state","updatedAt") SELECT session_row."id",session_row."userId",state_row."sessionSecurityVersion",session_row."createdAt"+INTERVAL '1 second',session_row."createdAt",'active',NOW() FROM "Session" session_row JOIN "AccountSecurityState" state_row ON state_row."userId"=session_row."userId" WHERE session_row."id"='session-u2'`, "session_security_activity_session_mismatch");
    rejectSql(`UPDATE "SessionSecurityActivity" SET "lastQualifyingAt"="lastQualifyingAt"-INTERVAL '1 second',"updatedAt"=NOW() WHERE "sessionId"='session-u1'`, "session_security_activity_qualifying_time_invalid");
    rejectSql(`UPDATE "SessionSecurityActivity" SET "warningAt"=NOW()+INTERVAL '1 hour',"updatedAt"=NOW() WHERE "sessionId"='session-u1'`, "session_security_activity_warning_invalid");
    rejectSql(`UPDATE "GlobalSecurityIncident" SET "normalizedKey"='forged-key' WHERE "id"='incident-u1'`, "global_security_incident_identity_immutable");
    rejectSql(`UPDATE "GlobalSecurityIncident" SET "failureCount"=0 WHERE "id"='incident-u1'`, "global_security_incident_counter_regression");
    sql(`UPDATE "GlobalSecurityIncident" SET "failureCount"=2,"lastOutcomeAt"=NOW() WHERE "id"='incident-u1'; UPDATE "GlobalSecurityIncident" SET "failureCount"=3,"lastOutcomeAt"=NOW() WHERE "id"='incident-u1'; UPDATE "GlobalSecurityIncident" SET "failureCount"=4,"lastOutcomeAt"=NOW() WHERE "id"='incident-u1'; UPDATE "GlobalSecurityIncident" SET "failureCount"=5,"lastOutcomeAt"=NOW(),"state"='quiet',"quietUntil"=NOW()+INTERVAL '15 minutes' WHERE "id"='incident-u1'`);
    rejectSql(`UPDATE "GlobalSecurityIncident" SET "state"='active',"quietUntil"=NULL WHERE "id"='incident-u1'`, "global_security_incident_quiet_period_regression");
    seedEmailOperation("u5", "1 second", "1 hour");
    seedEmailOperation("u4", "10 minutes", "10 seconds");
    sql(`BEGIN; ALTER TABLE "EmailChange" DISABLE TRIGGER "00_EmailChange_runtime_transition_guard"; UPDATE "EmailChange" SET "state"='verified',"updatedAt"=NOW() WHERE "id"='email-change-u4'; ALTER TABLE "EmailChange" ENABLE TRIGGER "00_EmailChange_runtime_transition_guard"; COMMIT`);
    sql(`SELECT pg_sleep(11)`);
    rejectSql(`BEGIN; ALTER TABLE "EmailChange" DISABLE TRIGGER "00_EmailChange_runtime_transition_guard"; UPDATE "EmailChange" SET "state"='completed',"updatedAt"=NOW() WHERE "id"='email-change-u4'; ALTER TABLE "EmailChange" ENABLE TRIGGER "00_EmailChange_runtime_transition_guard"; COMMIT`, "email_change_deadline_passed");
    sql(`BEGIN; ALTER TABLE "EmailChange" DISABLE TRIGGER "00_EmailChange_runtime_transition_guard"; UPDATE "EmailChange" SET "state"='expired',"updatedAt"=NOW() WHERE "id"='email-change-u4'; ALTER TABLE "EmailChange" ENABLE TRIGGER "00_EmailChange_runtime_transition_guard"; COMMIT`);
    sql(`ALTER TABLE "FreshAuthGrant" DISABLE TRIGGER ALL; UPDATE "FreshAuthGrant" SET "createdAt"=NOW()-INTERVAL '11 minutes',"expiresAt"=NOW()-INTERVAL '1 minute' WHERE "id"='grant-u5'; ALTER TABLE "FreshAuthGrant" ENABLE TRIGGER ALL; UPDATE "FreshAuthGrant" SET "state"='expired' WHERE "id"='grant-u5'`);
    sql(`BEGIN; ALTER TABLE "EmailChange" DISABLE TRIGGER "00_EmailChange_runtime_transition_guard"; UPDATE "EmailChange" SET "state"='verified',"updatedAt"=NOW() WHERE "id"='email-change-u5'; ALTER TABLE "EmailChange" ENABLE TRIGGER "00_EmailChange_runtime_transition_guard"; COMMIT`);

    sql(`
      ALTER TABLE "GlobalSecurityOperationTombstone" DISABLE TRIGGER "GlobalSecurityTombstone_insert_guard";
      ALTER TABLE "GlobalSecurityOperationReservationTombstone" DISABLE TRIGGER "GlobalSecurityReservationTombstone_insert_guard";
      INSERT INTO "GlobalSecurityOperationTombstone" ("userId","operationId","operationKey","intentFingerprint","terminalStatus","terminalCode","terminalAt","compactedAt") SELECT "userId","operationId","operationKey","intentFingerprint","status","outcomeCode","terminalAt",NOW() FROM "GlobalSecurityOperation" WHERE "userId"='u1' AND "operationId"='operation-terminal-u1';
      INSERT INTO "GlobalSecurityOperationReservationTombstone" ("userId","operationId","operationKey","sessionId","openingFingerprint","terminalCode","terminalAt","compactedAt") VALUES ('u1','operation-expired-u1','session_revoke','session-u1','opening-expired-u1','reservation_expired',NOW(),NOW());
      ALTER TABLE "GlobalSecurityOperationTombstone" ENABLE TRIGGER "GlobalSecurityTombstone_insert_guard";
      ALTER TABLE "GlobalSecurityOperationReservationTombstone" ENABLE TRIGGER "GlobalSecurityReservationTombstone_insert_guard";
    `);
    console.log("tombstone_retention_fixture_only");

    rejectSql(`SET cubby.global_security_account_deletion_user_id='["u1"]'; DELETE FROM "AccountSecurityState" WHERE "userId"='u1'`, "account_security_state_delete_forbidden");
    for (const table of retainedTables) rejectSql(`DELETE FROM "${table}" WHERE ${deleteFixtures[table]}`, deleteMarkers[table]);
    for (const table of retainedTables) rejectSql(`TRUNCATE TABLE "${table}" CASCADE`, "global_security_retention_truncate_forbidden");

    sql(`DELETE FROM "Session" WHERE "id"='session-u1'`);
    sql(`SELECT COUNT(*) FROM "FreshAuthGrant" WHERE "userId"='u1' UNION ALL SELECT COUNT(*) FROM "GlobalSecurityOperationBinding" WHERE "userId"='u1' UNION ALL SELECT COUNT(*) FROM "SessionSecurityActivity" WHERE "userId"='u1' UNION ALL SELECT COUNT(*) FROM "EmailChange" WHERE "userId"='u1'`, "2\n5\n1\n1");
    rejectSql(`BEGIN; ALTER TABLE "EmailChange" DISABLE TRIGGER "00_EmailChange_runtime_transition_guard"; UPDATE "EmailChange" SET "state"='verified',"updatedAt"=NOW() WHERE "id"='email-change-u1'; ALTER TABLE "EmailChange" ENABLE TRIGGER "00_EmailChange_runtime_transition_guard"; COMMIT`, "email_change_current_authorization_required");

    sql(`DELETE FROM "Session" WHERE "id"='session-u2'`);
    rejectSql(`UPDATE "GlobalSecurityOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeCode"='cutover_completed',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u2' AND "operationId"='operation-email-u2'`, "email_change_cutover_finalization_required");
    sql(`UPDATE "AccountSecurityState" SET "credentialVersion"=2,"lastCredentialOperationId"='independent-version-change-u2',"securityUpdatedAt"=NOW() WHERE "userId"='u2'`);
    rejectSql(`BEGIN; ALTER TABLE "EmailChange" DISABLE TRIGGER "00_EmailChange_runtime_transition_guard"; UPDATE "EmailChange" SET "state"='verified',"updatedAt"=NOW() WHERE "id"='email-change-u2'; ALTER TABLE "EmailChange" ENABLE TRIGGER "00_EmailChange_runtime_transition_guard"; COMMIT`, "email_change_current_authorization_required");
    sql(`UPDATE "FreshAuthGrant" SET "state"='revoked',"revokedAt"=NOW() WHERE "id"='grant-u3'`);
    rejectSql(`BEGIN; ALTER TABLE "EmailChange" DISABLE TRIGGER "00_EmailChange_runtime_transition_guard"; UPDATE "EmailChange" SET "state"='verified',"updatedAt"=NOW() WHERE "id"='email-change-u3'; ALTER TABLE "EmailChange" ENABLE TRIGGER "00_EmailChange_runtime_transition_guard"; COMMIT`, "email_change_current_authorization_required");

    sql(`INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u20','Synthetic User Twenty','u20@acceptance.invalid',true,NOW(),NOW()); INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u20',1,1,NOW())`);
    seedRecoverySet("u20");
    sql(`BEGIN;
      UPDATE "RecoveryCodeSet" SET "state"='save_acknowledged',"saveAcknowledgedAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u20' AND "setVersion"=1;
      UPDATE "RecoveryCodeSet" SET "state"='rehearsal_required',"updatedAt"=NOW() WHERE "userId"='u20' AND "setVersion"=1;
      UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='enrollment_rehearsal',"consumedOperationId"='recovery-issue-operation-u20',"consumedAt"=NOW() WHERE "id"='code-u20-1';
      UPDATE "RecoveryCodeSet" SET "state"='rehearsed',"rehearsedAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u20' AND "setVersion"=1;
      UPDATE "GlobalSecurityOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeCode"='rehearsal_completed',"outcomeSnapshot"='{"setVersion":1,"remainingCodes":9}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u20' AND "operationId"='recovery-issue-operation-u20';
      UPDATE "GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=NOW() WHERE "id"='recovery-issue-binding-u20';
      INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('event-recovery-enrollment-u20','u20','operation_outcome','completed','recovery-issue-operation-u20','{}',NOW());
      COMMIT;`);
    sql(`SELECT set."state" || '|' || count(*) FILTER (WHERE code."state"='active') || '|' || count(*) FILTER (WHERE code."state"='consumed' AND code."consumedPurpose"='enrollment_rehearsal') FROM "RecoveryCodeSet" set JOIN "RecoveryCode" code ON code."userId"=set."userId" AND code."setVersion"=set."setVersion" WHERE set."userId"='u20' GROUP BY set."state"`, "rehearsed|9|1");
    console.log("phase5_recovery_enrollment_rehearsal_finalization_pass");

    sql(`INSERT INTO "User" ("id","name","email","emailVerified","createdAt","updatedAt") VALUES ('u19','Synthetic User Nineteen','u19@acceptance.invalid',true,NOW(),NOW()); INSERT INTO "AccountSecurityState" ("userId","credentialVersion","sessionSecurityVersion","securityUpdatedAt") VALUES ('u19',1,1,NOW())`);
    seedRecoverySet("u19");
    retireRecoveryIssuanceSession("u19");
    rehearseRecoverySet("u19");
    retireRecoveryEnrollmentSession("u19");
    sql(`BEGIN;
      INSERT INTO "Account" ("id","accountId","providerId","userId","password","createdAt","updatedAt") VALUES ('credential-account-u19','credential-u19','credential','u19','recovery-old-hash',NOW(),NOW());
      INSERT INTO "RecoverySession" ("id","userId","recoveryCodeId","operationId","purpose","state","expiresAt","createdAt") VALUES ('recovery-session-u19','u19','code-u19-2','recovery-operation-u19','recovery_reset','restricted',NOW()+INTERVAL '10 minutes',NOW());
      INSERT INTO "GlobalSecurityOperationBinding" ("id","userId","recoverySessionId","operationId","operationKey","securityVersion","sessionSecurityVersion","openingFingerprint","targetSnapshot","state","expiresAt","createdAt","updatedAt") VALUES ('binding-recovery-u19','u19','recovery-session-u19','recovery-operation-u19','recovery_reset',1,1,'opening-recovery-u19','{}','open',NOW()+INTERVAL '10 minutes',NOW(),NOW());
      INSERT INTO "GlobalSecurityOperation" ("bindingId","userId","operationId","operationKey","intentFingerprint","status","createdAt","updatedAt") VALUES ('binding-recovery-u19','u19','recovery-operation-u19','recovery_reset','intent-recovery-u19','pending',NOW(),NOW());
      UPDATE "GlobalSecurityOperationBinding" SET "state"='submitted',"updatedAt"=NOW() WHERE "id"='binding-recovery-u19';
      UPDATE "RecoveryCode" SET "state"='consumed',"consumedPurpose"='recovery_reset',"consumedOperationId"='recovery-operation-u19',"consumedAt"=NOW() WHERE "id"='code-u19-2';
      UPDATE "AccountSecurityState" SET "credentialVersion"=2,"sessionSecurityVersion"=2,"lastCredentialOperationId"='recovery-operation-u19',"lastSessionSecurityOperationId"='recovery-operation-u19',"securityUpdatedAt"=NOW() WHERE "userId"='u19';
      SELECT "apply_recovery_reset_credential_mutation"('u19','recovery-operation-u19','credential-account-u19','recovery-new-hash');
      UPDATE "GlobalSecurityOperation" SET "status"='completed',"outcomeVersion"=1,"outcomeCode"='reset_completed',"outcomeSnapshot"='{}',"terminalAt"=NOW(),"updatedAt"=NOW() WHERE "userId"='u19' AND "operationId"='recovery-operation-u19';
      UPDATE "GlobalSecurityOperationBinding" SET "state"='terminal',"updatedAt"=NOW() WHERE "id"='binding-recovery-u19';
      UPDATE "RecoverySession" SET "state"='closed',"closedAt"=NOW() WHERE "id"='recovery-session-u19';
      INSERT INTO "GlobalSecurityEvent" ("id","userId","eventType","outcome","operationId","safeProjection","createdAt") VALUES ('event-recovery-u19','u19','operation_outcome','completed','recovery-operation-u19','{}',NOW());
      COMMIT;`);
    sql(`SELECT (account."password" <> 'recovery-old-hash') || '|' || operation."status" || '|' || operation."outcomeCode" || '|' || recovery."state" || '|' || state."credentialVersion" || '|' || state."sessionSecurityVersion" FROM "Account" account JOIN "GlobalSecurityOperation" operation ON operation."userId"=account."userId" JOIN "RecoverySession" recovery ON recovery."userId"=operation."userId" AND recovery."operationId"=operation."operationId" JOIN "AccountSecurityState" state ON state."userId"=operation."userId" WHERE account."id"='credential-account-u19'`, "true|completed|reset_completed|closed|2|2");
    console.log("phase5_recovery_reset_atomic_finalization_pass");
    sql(`SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('RecoveryCode','RecoveryCodeSet','RecoverySession') AND lower(column_name) IN ('plaintext','rawcode','codevalue','token','password','passwordhash')`, "0");
    console.log("phase5_recovery_plaintext_schema_exclusion_pass");

    sql(`DELETE FROM "User" WHERE "id" IN ('u1','u2','u3','u4','u5','u6','u7','u8','u9','u10','u11','u13','u14','u15','u16','u18','u19','u20','u22','u23','u24','u25','u26','u27','u28','u29','u30','u31','u32','u33','u34','phase6-inviter') OR "id" LIKE 'phase7-${suffix}-%'`);
    sql(`ALTER TABLE "GlobalSecurityIncident" DISABLE TRIGGER "GlobalSecurityIncident_retention_guard"; DELETE FROM "GlobalSecurityIncident" WHERE "userId" IS NULL; ALTER TABLE "GlobalSecurityIncident" ENABLE TRIGGER "GlobalSecurityIncident_retention_guard"; DELETE FROM "GlobalSecurityThrottleKey" WHERE "singletonId"=1`);
    sql(`SELECT string_agg(format('%s=%s', table_name, row_count), ',' ORDER BY table_name) FROM (SELECT 'AccountSecurityState' table_name,COUNT(*) row_count FROM "AccountSecurityState" UNION ALL SELECT 'EmailChange',COUNT(*) FROM "EmailChange" UNION ALL SELECT 'FreshAuthGrant',COUNT(*) FROM "FreshAuthGrant" UNION ALL SELECT 'GlobalSecurityEvent',COUNT(*) FROM "GlobalSecurityEvent" UNION ALL SELECT 'GlobalSecurityIncident',COUNT(*) FROM "GlobalSecurityIncident" UNION ALL SELECT 'GlobalSecurityOperation',COUNT(*) FROM "GlobalSecurityOperation" UNION ALL SELECT 'GlobalSecurityOperationBinding',COUNT(*) FROM "GlobalSecurityOperationBinding" UNION ALL SELECT 'GlobalSecurityOperationReservationTombstone',COUNT(*) FROM "GlobalSecurityOperationReservationTombstone" UNION ALL SELECT 'GlobalSecurityOperationTombstone',COUNT(*) FROM "GlobalSecurityOperationTombstone" UNION ALL SELECT 'GlobalSecurityThrottleKey',COUNT(*) FROM "GlobalSecurityThrottleKey" UNION ALL SELECT 'PasswordChangeCredentialMutation',COUNT(*) FROM "PasswordChangeCredentialMutation" UNION ALL SELECT 'RecoveryResetCredentialMutation',COUNT(*) FROM "RecoveryResetCredentialMutation" UNION ALL SELECT 'RecoveryCode',COUNT(*) FROM "RecoveryCode" UNION ALL SELECT 'RecoveryCodeSet',COUNT(*) FROM "RecoveryCodeSet" UNION ALL SELECT 'RecoverySession',COUNT(*) FROM "RecoverySession" UNION ALL SELECT 'SessionSecurityActivity',COUNT(*) FROM "SessionSecurityActivity") counts`, "AccountSecurityState=0,EmailChange=0,FreshAuthGrant=0,GlobalSecurityEvent=0,GlobalSecurityIncident=0,GlobalSecurityOperation=0,GlobalSecurityOperationBinding=0,GlobalSecurityOperationReservationTombstone=0,GlobalSecurityOperationTombstone=0,GlobalSecurityThrottleKey=0,PasswordChangeCredentialMutation=0,RecoveryCode=0,RecoveryCodeSet=0,RecoveryResetCredentialMutation=0,RecoverySession=0,SessionSecurityActivity=0");
    sql(`DROP OWNED BY cubby_runtime; DROP OWNED BY cubby_auth; DROP OWNED BY cubby_email_delivery; DROP OWNED BY cubby_security_operator; DROP ROLE cubby_runtime; DROP ROLE cubby_auth; DROP ROLE cubby_email_delivery; DROP ROLE cubby_security_operator`);

    console.log("P1_3_GLOBAL_SECURITY_PHASE1_ACCEPTANCE_PASS");
  } finally {
    spawnSync("docker", [...compose, "down", "--volumes", "--remove-orphans"], { cwd: root, env, stdio: "ignore" });
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (resourceCount("ps") || resourceCount("volume") || resourceCount("network") || existsSync(temporaryRoot)) {
      throw new Error("p1_3_phase1_acceptance_cleanup_incomplete");
    }
    console.log("P1_3_GLOBAL_SECURITY_PHASE1_ACCEPTANCE_CLEANUP_PASS");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runP13GlobalSecurityPhase1Acceptance().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
