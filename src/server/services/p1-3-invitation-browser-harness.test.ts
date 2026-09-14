import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSmtpEmailDeliveryAdapter } from "./smtp-email-delivery";

const source = readFileSync(resolve("scripts/p1-3-invitation.acceptance-rehearsal.ts"), "utf8");
const dockerfile = readFileSync(resolve("Dockerfile"), "utf8");
const parsed = ts.createSourceFile("harness.ts", source, ts.ScriptTarget.Latest, true);
const provisionerSource = readFileSync(resolve("scripts/provision-security-runtime-role.mjs"), "utf8");
const provisionerParsed = ts.createSourceFile("provision-security-runtime-role.mjs", provisionerSource, ts.ScriptTarget.Latest, true);
function p13InvitationSignInStatusExpression() {
  let expression: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.getText(parsed) === "cdpValue"
      && ts.isNoSubstitutionTemplateLiteral(node.arguments[1])
      && node.arguments[1].text.includes('performance.getEntriesByType("resource")')
      && node.arguments[1].text.includes('/api/auth/sign-in/email')
    ) expression = node.arguments[1].text;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!expression) throw new Error("Missing sign-in response status expression");
  return expression;
}

function p13InvitationRecoveryStageExpression() {
  let expression: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.getText(parsed) === "cdpValue"
      && ts.isNoSubstitutionTemplateLiteral(node.arguments[1])
      && node.arguments[1].text.includes('performance.getEntriesByType("resource")')
      && node.arguments[1].text.includes("/api/invitations/recovery/enrollment/reserve")
    ) expression = node.arguments[1].text;
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!expression) throw new Error("Missing recovery stage expression");
  return expression;
}
// Only named functions execute. Imports, CLI entry, processes and sockets never run.
function load(names: string[], dependencies: Record<string, unknown> = {}) {
  const declarations = names.map((name) => {
    const declaration = parsed.statements.find((node) =>
      (ts.isFunctionDeclaration(node) && node.name?.text === name)
      || (ts.isVariableStatement(node) && node.declarationList.declarations.some((candidate) => candidate.name.getText(parsed) === name))
    );
    if (!declaration) throw new Error(`Missing function ${name}`);
    return declaration.getText(parsed);
  }).join("\n");
  const compiled = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  return runInNewContext(`${compiled}\n({${names.join(",")}})`, {
    exports: {}, Error, URL, Buffer, setTimeout, clearTimeout, Date, performance: { now: () => Date.now() }, resolve, ...dependencies
  });
}

function loadProvisionerFunction(name: string) {
  const declaration = provisionerParsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing provisioner function ${name}`);
  const compiled = ts.transpileModule(declaration.getText(provisionerParsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  return runInNewContext(`${compiled}\n${name}`, { Error });
}

const context = { startupStatusRoot: "memory", temporaryRoot: "memory", env: {} };
afterEach(() => vi.useRealTimers());

describe("invitation browser harness behavioral boundaries", () => {
  it("reports observer absence when no action-local callback was delivered", async () => {
    const unsubscribe = vi.fn();
    const client = { on: vi.fn(() => unsubscribe), call: vi.fn().mockResolvedValue({}) };
    const { armP13InvitationRecoveryOriginObserver } = load(["p13InvitationRecoveryOriginObservation", "armP13InvitationRecoveryOriginObserver"]);
    const release = await armP13InvitationRecoveryOriginObserver(client);
    expect(await release() === "observer_absent").toBe(true);
    expect(await release() === "observer_absent").toBe(true);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(client.call.mock.calls.filter(([method]) => method === "Runtime.removeBinding").length).toBe(1);
  });

  it("keeps the runtime grant catalog aligned with the recovery fresh-auth procedure", () => {
    expect(source).toContain("bind_invitation_recovery_enrollment_fresh_auth_v2");
    expect(source).toContain('if (grants !== "33|33")');
  });

  it("re-enters the recipient password before the recovery generation action", async () => {
    let passwordEntered = false;
    let passwordBeforeGenerate = false;
    const { rehearseAndAcceptP13Invitation } = load(["rehearseAndAcceptP13Invitation"], {
      cdpValue: async (_client: unknown, expression: string) => expression === "location.pathname" ? "/app" : true,
      setP13BrowserInput: async (_client: unknown, selector: string, value: string) => {
        if (selector === 'input[autocomplete="current-password"]') passwordEntered = value === "source-fixture";
      },
      touchActivateP13BrowserText: async (_client: unknown, label: string) => { if (label === "Generate recovery codes") passwordBeforeGenerate = passwordEntered; },
      touchActivateP13BrowserSelector: async () => {}, keyboardActivateP13BrowserText: async () => {},
      assertP13Browser: async () => {}, waitForP13Browser: async (predicate: () => Promise<boolean>) => { expect(await predicate()).toBe(true); }
    });
    await rehearseAndAcceptP13Invitation({}, { password: "source-fixture", householdName: "Source household" }, false, false);
    expect(passwordBeforeGenerate).toBe(true);
  });

  it("preserves each active closed recovery-submit status category through the outer browser code", () => {
    const { p13InvitationRecoveryOriginObservation, p13InvitationRecoveryOriginFailureCode } = load([
      "p13InvitationRecoveryOriginObservation", "p13InvitationRecoveryOriginFailureCode"
    ]);
    for (const value of ["submit_terminal_completed", "submit_state_fresh_auth_bound", "submit_state_prepared", "submit_state_other", "submit_receipt_invalid", "submit_server_legacy_invalid", "submit_header_unsupported"]) {
      const observed = p13InvitationRecoveryOriginObservation(value);
      expect(observed).toBe(value);
      expect(p13InvitationRecoveryOriginFailureCode(observed)).toBe(`p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_origin_${value}_failed`);
    }
  });

  it("does not arm the prohibited body-schema observer during the recovery action", async () => {
    const armSchema = vi.fn(async () => async () => undefined);
    const { rehearseAndAcceptP13Invitation } = load(["rehearseAndAcceptP13Invitation"], {
      cdpValue: async (_client: unknown, expression: string) => expression === "location.pathname" ? "/app" : true,
      setP13BrowserInput: async () => {}, touchActivateP13BrowserText: async () => {},
      touchActivateP13BrowserSelector: async () => {}, keyboardActivateP13BrowserText: async () => {},
      assertP13Browser: async () => {}, waitForP13Browser: async (predicate: () => Promise<boolean>) => { expect(await predicate()).toBe(true); },
      armP13InvitationRecoveryNetworkObserver: async () => async () => ({}),
      armP13InvitationRecoverySchemaObserver: armSchema,
      armP13InvitationRecoveryOriginObserver: async () => async () => "observer_absent"
    });
    await rehearseAndAcceptP13Invitation({}, { password: "source-fixture", householdName: "Source household" }, false, true);
    expect(armSchema.mock.calls.length).toBe(0);
  });

  it("requires the established runtime and auth relation grants in the acceptance catalog", () => {
    const { p13InvitationPermissionCatalogChecks } = load(["p13InvitationPermissionCatalogChecks"]);
    const compatibility = p13InvitationPermissionCatalogChecks().find(
      (check: { category: string }) => check.category === "established_role_compatibility",
    );
    expect(compatibility?.statement).toContain("has_table_privilege('cubby_runtime','public.\"User\"','SELECT')");
    expect(compatibility?.statement).toContain("has_table_privilege('cubby_auth','public.\"Account\"','SELECT')");
    expect(compatibility?.statement).toContain("has_table_privilege('cubby_auth','public.\"Session\"','INSERT,UPDATE,DELETE')");
  });

  it("supplies generated SMTP settings before the compiled app starts its delivery scheduler", () => {
    const { safeEnvironment } = load(["hostExecutableEnvironment", "safeEnvironment"], { process: { env: {} }, randomBytes: () => Buffer.from("distinct-smtp-secret") });
    const environment = safeEnvironment("generated_user", "generated_database", "generated_password");
    const createTransport = vi.fn(() => ({ sendMail: vi.fn() })) as never;

    expect(() => createSmtpEmailDeliveryAdapter(environment, { createTransport })).not.toThrow();
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "127.0.0.1",
      port: 1,
      secure: false,
      auth: { user: "generated_user_smtp", pass: Buffer.from("distinct-smtp-secret").toString("base64url") }
    }));
  });

  it("never hands the disposable database owner password to the app as its SMTP password", () => {
    const { safeEnvironment } = load(["hostExecutableEnvironment", "safeEnvironment"], { process: { env: {} }, randomBytes: () => Buffer.from("distinct-smtp-secret") });
    const environment = safeEnvironment("generated_user", "generated_database", "generated_password");

    expect(environment.CUBBY_BROWSER_OPERATION_ACCEPTANCE_PASSWORD).toBe("generated_password");
    expect(environment.SMTP_PASSWORD).toBe(Buffer.from("distinct-smtp-secret").toString("base64url"));
    expect(environment.SMTP_PASSWORD).not.toBe("generated_password");
  });

  it("keeps its deadline when the wall clock moves backwards", async () => {
    vi.useFakeTimers();
    let elapsed = 0;
    let finished = false;
    const { waitForP13InvitationAppHealth } = load(["waitForP13InvitationAppHealth", "p13InvitationAppHealthFailureCode"], {
      performance: { now: () => elapsed },
      setTimeout: (done: () => void, delay: number) => setTimeout(() => { elapsed += delay; done(); }, delay),
      p13InvitationTlsStatus: async () => 502, p13InvitationAppStartupFailureCode: () => ""
    });
    void waitForP13InvitationAppHealth(context, "unused").catch(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() - 120_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(finished).toBe(true);
  });

  it("defers exact mobile dimensions while the initial blank document has no viewport metadata", async () => {
    const client = { call: vi.fn().mockResolvedValue({}) };
    const assertP13Browser = vi.fn(async (_client: unknown, expression: string) => {
      if (!expression.includes("document.querySelector")) throw new Error("p1_3_invitation_acceptance_browser_geometry_invalid");
    });
    const { setP13BrowserViewport } = load(["setP13BrowserViewport"], { assertP13Browser });

    await expect(setP13BrowserViewport(client, 375, 812, true)).resolves.toBeUndefined();
    expect(client.call).toHaveBeenCalledWith("Emulation.setDeviceMetricsOverride", {
      width: 375, height: 812, deviceScaleFactor: 1, mobile: true, screenWidth: 375, screenHeight: 812
    });
  });

  it("classifies a missing response-loss interception separately from an interceptor failure", async () => {
    vi.useFakeTimers();
    const client = { on: vi.fn(() => () => {}), call: vi.fn().mockResolvedValue({}) };
    const { armP13ResponseLoss } = load(["waitForP13Browser", "armP13ResponseLoss"], { cdpValue: async () => false });
    const release = await armP13ResponseLoss(client, "https://127.0.0.1:1234/api/invitations/credentials/submit");
    const result = release().catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toBe("p1_3_invitation_acceptance_browser_response_loss_not_intercepted");
  });

  it("arms response-stage interception for every browser fetch and filters the exact submission URL in memory", async () => {
    const client = { on: vi.fn(() => () => {}), call: vi.fn().mockResolvedValue({}) };
    const { armP13ResponseLoss } = load(["armP13ResponseLoss"], { waitForP13Browser: async () => {} });

    await armP13ResponseLoss(client, "https://127.0.0.1:1234/api/invitations/credentials/submit");
    expect(client.call).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Fetch", requestStage: "Response" }]
    });
  });

  it("accepts only the closed recovery submit schema classification from the disposable CDP binding", async () => {
    let bindingCalled!: (params: Record<string, unknown>) => void;
    const client = {
      on: vi.fn((_method: string, handler: (params: Record<string, unknown>) => void) => { bindingCalled = handler; return () => {}; }),
      call: vi.fn().mockResolvedValue({})
    };
    const { armP13InvitationRecoverySchemaObserver } = load(["p13InvitationRecoverySchemaObservation", "armP13InvitationRecoverySchemaObserver"]);

    const release = await armP13InvitationRecoverySchemaObserver(client);
    bindingCalled({ name: "__cubbyP13RecoverySchemaObserver", payload: JSON.stringify({ statusClass: "2xx", ok: "true", data: "present", terminal: "completed", count: "exactly_10", shape: "valid" }) });

    await expect(release()).resolves.toEqual({ statusClass: "2xx", ok: "true", data: "present", terminal: "completed", count: "exactly_10", shape: "valid" });
    expect(client.call).toHaveBeenCalledWith("Runtime.addBinding", { name: "__cubbyP13RecoverySchemaObserver" });
    expect(client.call).toHaveBeenCalledWith("Runtime.removeBinding", { name: "__cubbyP13RecoverySchemaObserver" });
  });

  it("fails closed on a non-schema payload and builds the observer into only the disposable image", async () => {
    let bindingCalled!: (params: Record<string, unknown>) => void;
    const client = {
      on: vi.fn((_method: string, handler: (params: Record<string, unknown>) => void) => { bindingCalled = handler; return () => {}; }),
      call: vi.fn().mockResolvedValue({})
    };
    const { armP13InvitationRecoverySchemaObserver, p13InvitationRecoverySchemaFailureCode } = load(["p13InvitationRecoverySchemaObservation", "armP13InvitationRecoverySchemaObserver", "p13InvitationRecoverySchemaFailureCode"]);
    const release = await armP13InvitationRecoverySchemaObserver(client);
    bindingCalled({ name: "__cubbyP13RecoverySchemaObserver", payload: "not-json" });

    expect(p13InvitationRecoverySchemaFailureCode(await release())).toBe("p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_schema_observer_absent_failed");
    expect(source).toContain("NEXT_PUBLIC_CUBBY_P13_RECOVERY_SCHEMA_OBSERVER: \"1\"");
    expect(source).toContain("CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER: \"1\"");
    expect(source).toContain("CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER=${context.env.CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER ?? \"\"}");
    expect(source).toContain("--build-arg");
    expect(dockerfile).toContain("ARG CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER=\"\"");
    expect(dockerfile).toContain("ENV CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER=$CUBBY_P13_RECOVERY_ROUTE_ORIGIN_OBSERVER");
  });

  it("accepts only the one closed route-origin label from the designated action-local binding", async () => {
    let bindingCalled!: (params: Record<string, unknown>) => void;
    const client = {
      on: vi.fn((_method: string, handler: (params: Record<string, unknown>) => void) => { bindingCalled = handler; return () => {}; }),
      call: vi.fn().mockResolvedValue({})
    };
    const { armP13InvitationRecoveryOriginObserver, p13InvitationRecoveryOriginFailureCode } = load(["p13InvitationRecoveryOriginObservation", "armP13InvitationRecoveryOriginObserver", "p13InvitationRecoveryOriginFailureCode"]);

    const release = await armP13InvitationRecoveryOriginObserver(client);
    bindingCalled({ name: "__cubbyP13RecoveryOriginObserver", payload: "submit_terminal_unavailable" });

    await expect(release()).resolves.toBe("submit_terminal_unavailable");
    expect(p13InvitationRecoveryOriginFailureCode("submit_terminal_unavailable")).toBe("p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_origin_submit_terminal_unavailable_failed");
    expect(client.call).toHaveBeenCalledWith("Runtime.addBinding", { name: "__cubbyP13RecoveryOriginObserver" });
    expect(client.call).toHaveBeenCalledWith("Runtime.removeBinding", { name: "__cubbyP13RecoveryOriginObserver" });
  });

  it("delivers a complete Enter key payload after focusing a keyboard-activated control", async () => {
    const client = { call: vi.fn().mockResolvedValue({}) };
    const { keyboardActivateP13BrowserText } = load(["keyboardActivateP13BrowserText"], { cdpValue: async () => true });

    await keyboardActivateP13BrowserText(client, "Create sign-in details");
    expect(client.call).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
    });
  });

  it("cancels the proxy upstream when the bounded probe disconnects", async () => {
    let handler!: (incoming: unknown, outgoing: unknown) => void;
    const upstream = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    const { startP13InvitationTlsProxy } = load(["startP13InvitationTlsProxy"], {
      createHttpsServer: (_options: unknown, callback: typeof handler) => {
        handler = callback;
        return { once() {}, listen(_port: number, _host: string, ready: () => void) { ready(); }, address: () => ({ port: 1234 }), close(done: () => void) { done(); } };
      }, httpRequest: () => upstream
    });
    const proxy = await startP13InvitationTlsProxy(Buffer.alloc(0), Buffer.alloc(0));
    proxy.setUpstream(1235);
    const response = Object.assign(new EventEmitter(), { end() {} });
    handler({ headers: {}, pipe() {} }, response);
    response.emit("close");
    expect(upstream.destroy).toHaveBeenCalledOnce();
    await proxy.close();
  });

  it("fails a CDP handshake immediately on child start failure", async () => {
    const browser = Object.assign(new EventEmitter(), { stdio: [null, null, null, new PassThrough(), new PassThrough()] });
    const { connectP13InvitationCdp } = load(["connectP13InvitationCdp"]);
    const result = connectP13InvitationCdp(browser).catch((error: Error) => error.message);
    browser.emit("error", new Error("synthetic"));
    expect(await result).toBe("p1_3_invitation_acceptance_browser_cdp_failed");
  });

  it("verifies the Node/TSX fixed-code IPC transport with a synthetic child only", async () => {
    const fixture = resolve("../../../worker-runtime/p13-source-ipc-fixture.ts");
    const code = "p1_3_invitation_acceptance_runtime_probe_failed";
    writeFileSync(fixture, `const code: string = ${JSON.stringify(code)}; process.send!(code); process.exitCode = 1;\n`);
    const { runRuntimeProbe } = load(["runRuntimeProbe"], {
      spawn, root: process.cwd(), runtimeDiagnosticCodes: new Set([code]),
      p13InvitationRuntimeProbeCommand: () => ({ executable: process.execPath, args: ["--import", "tsx", fixture] })
    });
    await expect(runRuntimeProbe(context)).rejects.toThrow(code);
    // Retain the generated source fixture; no retained-resource cleanup.
  });

  it("rejects an invalid mode before creating any lifecycle", async () => {
    const createLifecycle = vi.fn();
    const { runP13InvitationAcceptance } = load(["runP13InvitationAcceptance"], {
      createLifecycle, executeP13InvitationAcceptance: async () => {}, process: { stdout: { write() {} } }
    });
    await expect(runP13InvitationAcceptance("unexpected")).rejects.toThrow("p1_3_invitation_acceptance_failed");
    expect(createLifecycle).not.toHaveBeenCalled();
  });

  it("preserves a fixed global-role stage through the outer preparation boundary without reading raw output", () => {
    const code = "p1_3_invitation_acceptance_global_role_input_failed";
    const spawnSync = vi.fn((_command, _args, options) => {
      expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]);
      return { status: 1, stdout: `${code}\n`, get stderr() { throw new Error("raw output accessed"); } };
    });
    const { p13InvitationAcceptanceFailureCode, run } = load([
      "preparationDiagnosticCodes",
      "isPreparationDiagnosticError",
      "p13InvitationAcceptanceFailureCode",
      "run"
    ], { root: "memory", spawnSync });

    expect(() => run("node", ["provision-security-runtime-role.mjs"], {}, "p1_3_invitation_acceptance_global_role_provision_failed")).toThrow(code);
    expect(p13InvitationAcceptanceFailureCode(new Error(code))).toBe(code);
  });

  it("preserves only a fixed SQLSTATE class from global-role application without exposing database text", () => {
    const code = "p1_3_invitation_acceptance_global_role_apply_sqlstate_42501";
    const spawnSync = vi.fn((_command, _args, options) => {
      expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]);
      return { status: 1, stdout: `${code}\n`, get stderr() { throw new Error("raw output accessed"); } };
    });
    const { p13InvitationAcceptanceFailureCode, run } = load([
      "preparationDiagnosticCodes",
      "isPreparationDiagnosticError",
      "p13InvitationAcceptanceFailureCode",
      "run"
    ], { root: "memory", spawnSync });
    const globalRoleApplyFailureCode = loadProvisionerFunction("globalRoleApplyFailureCode");

    expect(globalRoleApplyFailureCode({ meta: { code: "42501", message: "private database message" } })).toBe(code);
    expect(globalRoleApplyFailureCode({ meta: { code: "99999", message: "private database message" } }))
      .toBe("p1_3_invitation_acceptance_global_role_apply_failed");
    expect(() => run("node", ["provision-security-runtime-role.mjs"], {}, "p1_3_invitation_acceptance_global_role_provision_failed")).toThrow(code);
    expect(p13InvitationAcceptanceFailureCode(new Error(code))).toBe(code);
  });

  it("separates the restricted-ownership guard and an unreachable database from other apply failures", () => {
    const globalRoleApplyFailureCode = loadProvisionerFunction("globalRoleApplyFailureCode");
    // The provisioner's own RAISE EXCEPTION guard reports P0001; it is a source repair, not infrastructure.
    expect(globalRoleApplyFailureCode({ meta: { code: "P0001", get message(): never { throw new Error("raw detail accessed"); } } }))
      .toBe("p1_3_invitation_acceptance_global_role_apply_sqlstate_p0001");
    // Prisma initialization/connection errors carry no SQLSTATE and mean the disposable database was not reachable.
    for (const unreachable of [{ errorCode: "P1001" }, { code: "P1017" }, { errorCode: "P1000" }]) {
      expect(globalRoleApplyFailureCode(unreachable)).toBe("p1_3_invitation_acceptance_global_role_apply_unreachable");
    }
    expect(globalRoleApplyFailureCode({ meta: { code: "99999" } })).toBe("p1_3_invitation_acceptance_global_role_apply_failed");
    expect(globalRoleApplyFailureCode(null)).toBe("p1_3_invitation_acceptance_global_role_apply_failed");
  });

  it("captures and classifies the fixed established-role compatibility result", () => {
    const code = "p1_3_invitation_acceptance_permission_established_role_compatibility_invalid";
    const spawnSync = vi.fn((_command, _args, options) => {
      expect(options.stdio).toEqual(["ignore", "pipe", "ignore"]);
      return { status: 0, stdout: "1\n", get stderr() { throw new Error("raw output accessed"); } };
    });
    const { p13InvitationAcceptanceFailureCode, run } = load([
      "databaseDiagnosticCodes",
      "isDatabaseDiagnosticError",
      "p13InvitationAcceptanceFailureCode",
      "run"
    ], {
      root: "memory",
      spawnSync,
      isPreparationDiagnosticError: () => false,
      isRuntimeDiagnosticError: () => false,
      isBrowserDiagnosticError: () => false
    });

    expect(run("docker", ["exec", "postgres"], {}, code)).toBe("1");
    expect(p13InvitationAcceptanceFailureCode(new Error(code))).toBe(code);
  });

  it("allows a source-first service reproducer on the same isolated preparation path", async () => {
    const probe = vi.fn(async () => {});
    const defaultProbe = vi.fn(async () => {});
    const { createLifecycle } = load(["createLifecycle"], {
      process: { env: { CUBBY_P13_INVITATION_LIFECYCLE_SUFFIX: "0123456789abcdef" }, stdout: { write() {} } },
      randomBytes: () => Buffer.from("source-fixture"), safeEnvironment: () => ({ CUBBY_BROWSER_OPERATION_ACCEPTANCE_PASSWORD: "source-fixture" }),
      workerRuntime: "C:/Projects/Cubby/worker-runtime", root: "C:/Projects/Cubby/worktrees/Cubby/p1-3-invitation-initial-credentials-v2", composeFile: "compose.yml",
      dirname, existsSync: () => false, mkdirSync: () => {}, copyCurrentPrisma: () => {},
      configureP13InvitationBrowserEnvironment: () => {}, assertP13InvitationDisposablePreflight: () => {}, verifyP13InvitationNormalRuntime: () => {},
      run: () => "127.0.0.1:1", postgresUrl: () => "source-fixture", roleUrl: () => "source-fixture", runRuntimeProbe: defaultProbe
    });
    const lifecycle = createLifecycle("diagnostic", probe);
    await lifecycle.prepare();
    await lifecycle.verifyInvitationRuntime();
    expect(probe.mock.calls.length).toBe(1);
    expect(defaultProbe.mock.calls.length).toBe(0);
  });

  it("still proves residue absence and normal-runtime non-effect when temporary-root removal fails", async () => {
    let removalAttempted = false;
    const resourceCount = vi.fn(() => "");
    const verifyP13InvitationNormalRuntime = vi.fn();
    const { createLifecycle } = load(["createLifecycle", "p13InvitationDisposablePreflightFailureCode"], {
      process: { env: { CUBBY_P13_INVITATION_LIFECYCLE_SUFFIX: "0123456789abcdef" }, stdout: { write() {} } },
      randomBytes: () => Buffer.from("generated"),
      safeEnvironment: () => ({ CUBBY_BROWSER_OPERATION_ACCEPTANCE_PASSWORD: "generated" }),
      workerRuntime: "C:/Projects/Cubby/worker-runtime",
      root: "C:/Projects/Cubby/worktrees/Cubby/p1-3-post-merge-hardening",
      composeFile: "compose.yml",
      dirname,
      existsSync: () => removalAttempted,
      mkdirSync: () => {},
      configureP13InvitationBrowserEnvironment: () => {},
      spawnSync: () => ({ status: 0 }),
      rmSync: () => { removalAttempted = true; throw new Error("synthetic locked profile"); },
      resourceCount,
      verifyP13InvitationNormalRuntime
    });
    const lifecycle = createLifecycle("diagnostic");

    await expect(lifecycle.cleanup()).rejects.toThrow("p1_3_invitation_acceptance_cleanup_failed");
    expect(resourceCount).toHaveBeenCalled();
    expect(verifyP13InvitationNormalRuntime).toHaveBeenCalledOnce();
  });

  it("uses a pre-reserved disposable project and temporary root before resource creation", () => {
    const output: string[] = [];
    const mkdirSync = vi.fn();
    const mkdtempSync = vi.fn(() => "unexpected-generated-root");
    const suffix = "936d17a85b169865";
    const temporaryRoot = "C:/Projects/Cubby/worker-runtime/cubby-p1-3-invitation-4j4bYCo";
    const { createLifecycle } = load(["createLifecycle"], {
      process: {
        env: {
          CUBBY_P13_INVITATION_LIFECYCLE_SUFFIX: suffix,
          CUBBY_P13_INVITATION_TEMPORARY_ROOT: temporaryRoot
        },
        stdout: { write: (line: string) => output.push(line) }
      },
      randomBytes: () => Buffer.from("generated"),
      safeEnvironment: () => ({ CUBBY_BROWSER_OPERATION_ACCEPTANCE_PASSWORD: "generated" }),
      workerRuntime: "C:/Projects/Cubby/worker-runtime",
      root: "C:/Projects/Cubby/worktrees/Cubby/p1-3-invitation-initial-credentials-v2",
      composeFile: "compose.yml",
      dirname,
      existsSync: () => false,
      mkdirSync,
      mkdtempSync,
      configureP13InvitationBrowserEnvironment: vi.fn()
    });

    createLifecycle("diagnostic");

    expect(mkdtempSync).not.toHaveBeenCalled();
    expect(output).toEqual([
      `p1_3_invitation_project=cubby-p1-3-invitation-${suffix}\n`,
      `p1_3_invitation_temporary_root=${resolve(temporaryRoot)}\n`
    ]);
  });

  it("launches browser CDP without a stderr log-discovery channel", async () => {
    const spawn = vi.fn((_executable, args, options) => {
      expect(args).toContain("--remote-debugging-pipe");
      expect(options.stdio).toEqual(["ignore", "ignore", "ignore", "pipe", "pipe"]);
      const child = Object.assign(new EventEmitter(), { pid: 1 });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const { launchP13Browser } = load(["launchP13Browser"], {
      browserExecutables: ["synthetic"], existsSync: () => true, spawn,
      hostExecutableEnvironment: () => ({})
    });
    expect((await launchP13Browser("memory")).process.pid).toBe(1);
  });

  it("carries existing page CDP over framed pipes without log or HTTP discovery", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const calls: Array<{ id: number; method: string; sessionId?: string }> = [];
    input.on("data", (chunk) => {
      const command = JSON.parse(chunk.toString().slice(0, -1));
      calls.push(command);
      const result = command.method === "Target.createTarget" ? { targetId: "target" } : command.method === "Target.attachToTarget" ? { sessionId: "session" } : {};
      output.write(`${JSON.stringify({ id: command.id, result })}\0`);
    });
    const { connectP13InvitationCdp } = load(["connectP13InvitationCdp"]);
    const client = await connectP13InvitationCdp(Object.assign(new EventEmitter(), { stdio: [null, null, null, input, output] }));
    await client.call("Page.enable");
    expect(calls.map(({ method }) => method)).toEqual(["Target.createTarget", "Target.attachToTarget", "Page.enable"]);
    expect(calls[2].sessionId).toBe("session");
    client.close();
  });

  it("checks denial by a fixed SQLSTATE trap without capturing database errors", () => {
    const statement = "SELECT * FROM public.\"FreshAuthAttestationKey\";";
    let status = 0;
    const spawnSync = vi.fn((_command, args, options) => {
      expect(options.stdio).toEqual(["ignore", "ignore", "ignore"]);
      expect(args.at(-1)).toContain("EXCEPTION WHEN insufficient_privilege THEN RETURN");
      expect(args.at(-1)).toContain("RAISE EXCEPTION USING ERRCODE = 'P0001'");
      return { status, get stderr() { throw new Error("raw output accessed"); } };
    });
    const { expectRejected } = load(["expectRejected"], { root: "memory", spawnSync });
    expectRejected("docker", ["-c", statement], {}, "p1_3_invitation_acceptance_key_read_not_denied", "permission denied");
    status = 1;
    expect(() => expectRejected("docker", ["-c", statement], {}, "p1_3_invitation_acceptance_key_read_not_denied", "permission denied")).toThrow("p1_3_invitation_acceptance_key_read_not_denied");
  });

  it("receives only the existing runtime code with both raw streams disconnected", async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    const spawn = vi.fn((_command, _args, options) => {
      expect(options.stdio).toEqual(["ignore", "ignore", "ignore", "ipc"]);
      return child;
    });
    const code = "p1_3_invitation_acceptance_runtime_probe_failed";
    const { runRuntimeProbe } = load(["runRuntimeProbe"], {
      spawn, spawnSync: () => { throw new Error("raw synchronous capture"); },
      root: "memory", p13InvitationRuntimeProbeCommand: () => ({ executable: "unused", args: [] }),
      runtimeDiagnosticCodes: new Set([code])
    });
    const result = runRuntimeProbe(context).catch((error: Error) => error.message);
    child.emit("message", code);
    child.emit("exit", 1);
    expect(await result).toBe(code);
  });

  it.each([undefined, 502, 500])("bounds unavailable readiness and retains final HTTP category %s", async (status) => {
    vi.useFakeTimers();
    const { waitForP13InvitationAppHealth } = load([
      "waitForP13InvitationAppHealth", "p13InvitationAppHealthFailureCode",
      "p13InvitationInstrumentationFailureCode", "p13InvitationInstrumentationStageFailureCode"
    ], {
      p13InvitationAppStartupFailureCode: () => "",
      p13InvitationTlsStatus: async () => status,
      existsSync: () => false
    });
    const result = waitForP13InvitationAppHealth(context, "unused").catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBe(status === undefined ? "p1_3_invitation_acceptance_browser_app_health_unreachable" : status === 502 ? "p1_3_invitation_acceptance_browser_tls_proxy_upstream_error" : "p1_3_invitation_acceptance_browser_instrumentation_builtin_probe_failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies a persistent app 500 from the allowlisted instrumentation marker after startup", async () => {
    vi.useFakeTimers();
    const instrumentationFailure = "p1_3_invitation_acceptance_browser_instrumentation_email_change_start_failed";
    const { waitForP13InvitationAppHealth } = load([
      "waitForP13InvitationAppHealth", "p13InvitationAppHealthFailureCode",
      "p13InvitationInstrumentationFailureCode", "p13InvitationInstrumentationStageFailureCode"
    ], {
      p13InvitationAppStartupFailureCode: () => "",
      p13InvitationTlsStatus: async () => 500,
      existsSync: () => true,
      readFileSync: () => "email_delivery_started\n"
    });
    const result = waitForP13InvitationAppHealth(context, "unused").catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBe(instrumentationFailure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept whitespace-normalized or unreadable startup markers", async () => {
    const { p13InvitationAppStartupFailureCode } = load(["p13InvitationAppStartupFailureCode"], {
      existsSync: () => true, readFileSync: () => " server|starting \n"
    });
    expect(p13InvitationAppStartupFailureCode(context)).toBe("p1_3_invitation_acceptance_browser_app_startup_status_invalid");
  });

  it("destroys a successful header-only probe rather than draining an unbounded body", async () => {
    vi.useFakeTimers();
    let respond!: (response: unknown) => void;
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    const { p13InvitationTlsStatus } = load(["p13InvitationTlsStatus"], { httpsRequest: (_options: unknown, callback: typeof respond) => { respond = callback; return request; } });
    const result = p13InvitationTlsStatus("https://127.0.0.1:1234", "/api/health");
    const response = { statusCode: 204, destroy: vi.fn(), resume: vi.fn() };
    respond(response);
    expect(await result).toBe(204);
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(response.resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["/app/.next/server/instrumentation", "/app/.next/server/instrumentation.js"])("recognizes the installed Next instrumentation request %s", (request) => {
    const writes: string[] = [];
    const Module = { prototype: { _compile() {} }, _load: (_request: string, _parent: unknown): { startServer(): void } => ({ startServer() {} }) };
    const preload = readFileSync(resolve("scripts/p1-3-standalone-bootstrap-probe.cjs"), "utf8");
    runInNewContext(`(function () { ${preload}\n})()`, {
      process: { env: { CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE: "/run/cubby-acceptance-status/instrumentation-stage" }, cwd: () => "/app", getBuiltinModule: (name: string) => name === "fs" ? { writeFileSync: (_file: string, value: string) => writes.push(value.trim()) } : Module }
    });
    Reflect.apply(Module.prototype._compile, {}, ["", "/app/server.js"]);
    Module._load("next", { filename: "/app/server.js" });
    const server = Module._load("next/dist/server/lib/start-server", { filename: "/app/server.js" });
    // A previously observed event must not be lost merely because of order.
    Module._load("./next-server", { filename: "/app/node_modules/next/dist/server/next.js" });
    server.startServer();
    Module._load(request, {});
    expect(writes).toEqual(["preload_file_loaded", "preload_guards_confirmed", "standalone_server_module_entered", "next_package_loaded", "start_server_module_loaded", "start_server_invoked", "next_server_module_loaded", "instrumentation_module_load_requested"]);
  });

  it("discards build output at the child boundary on success and failure", () => {
    let status = 0;
    const spawnSync = vi.fn((_command, _args, options) => {
      expect(options.stdio).toEqual(["ignore", "ignore", "ignore"]);
      return { status, get stdout() { throw new Error("raw output accessed"); }, get stderr() { throw new Error("raw output accessed"); } };
    });
    const { run } = load(["run"], { root: "memory", spawnSync });
    expect(run("synthetic-build", [], {}, "p1_3_invitation_acceptance_browser_app_build_failed")).toBe("");
    status = 1;
    expect(() => run("synthetic-build", [], {}, "p1_3_invitation_acceptance_browser_app_build_failed")).toThrow("p1_3_invitation_acceptance_browser_app_build_failed");
  });

  it("never labels diagnostic-only completion as full acceptance", async () => {
    const output: string[] = [];
    const modes: string[] = [];
    const { runP13InvitationAcceptance } = load(["runP13InvitationAcceptance"], {
      createLifecycle: (mode: string) => { modes.push(mode); return {}; },
      executeP13InvitationAcceptance: async (_lifecycle: unknown, complete: () => void) => complete(),
      process: { stdout: { write: (value: string) => output.push(value) } }
    });
    await runP13InvitationAcceptance("diagnostic");
    await runP13InvitationAcceptance("acceptance");
    expect(modes).toEqual(["diagnostic", "acceptance"]);
    expect(output).toEqual(["p1_3_invitation_acceptance_browser_instrumentation_and_route_confirmed\n", "p1_3_invitation_acceptance_complete\n"]);
  });

  it("aborts a hung request on a fixed deadline without reading content", async () => {
    vi.useFakeTimers();
    const request = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    const { p13InvitationTlsStatus } = load(["p13InvitationTlsStatus"], { httpsRequest: () => request });
    const result = p13InvitationTlsStatus("https://127.0.0.1:1234", "/api/health", 250).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(250);
    expect(request.destroy).toHaveBeenCalledOnce();
    expect(await result).toBe("p1_3_invitation_acceptance_browser_app_health_unreachable");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["readiness_guard", "configuration", "runtime_role", "invitation_runtime_roles", "migration_connection", "migration_apply", "fresh_auth_attestation_keys", "email_delivery_keys", "global_security_throttle_key"])("fails immediately on terminal startup %s", async (phase) => {
    const request = vi.fn();
    const { waitForP13InvitationAppHealth } = load(["waitForP13InvitationAppHealth", "p13InvitationAppStartupFailureCode"], {
      existsSync: () => true, readFileSync: () => `${phase}|failed\n`, p13InvitationTlsStatus: request
    });
    await expect(waitForP13InvitationAppHealth(context, "unused")).rejects.toThrow(`p1_3_invitation_acceptance_browser_app_${phase}_failed`);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([502, 500])("preserves HTTP %s rather than attributing an earlier stage", async (status) => {
    const { verifyP13InvitationInstrumentationStage } = load([
      "verifyP13InvitationInstrumentationStage", "p13InvitationInstrumentationStageFailureCode", "p13InvitationAppHealthFailureCode"
    ], { p13InvitationTlsStatus: async () => status, existsSync: () => true, readFileSync: () => "node_builtin_ready\n" });
    await expect(verifyP13InvitationInstrumentationStage(context, "unused")).rejects.toThrow(status === 502 ? "tls_proxy_upstream_error" : "app_health_route_error");
  });

  it("returns diagnostic confirmation instead of throwing a success as failure", async () => {
    const { verifyP13InvitationInstrumentationStage } = load([
      "verifyP13InvitationInstrumentationStage", "p13InvitationInstrumentationFailureCode",
      "p13InvitationInstrumentationStageFailureCode", "p13InvitationAppHealthFailureCode"
    ], { p13InvitationTlsStatus: async () => 204, existsSync: () => true, readFileSync: () => "email_change_lifecycle_started\n" });
    await expect(verifyP13InvitationInstrumentationStage(context, "unused")).resolves.toBe("p1_3_invitation_acceptance_browser_instrumentation_and_route_confirmed");
  });

  it.each(["acceptance", "diagnostic"])("orders readiness before stages and respects %s mode", async (mode) => {
    const events: string[] = [];
    const { runP13InvitationBrowserCdp } = load(["runP13InvitationBrowserCdp"], {
      run: (_command: string, _args: unknown, _env: unknown, code: string) => code.endsWith("_port_failed") ? "127.0.0.1:1234" : "",
      readFileSync: () => Buffer.alloc(0),
      startP13InvitationTlsProxy: async () => ({ origin: "unused", setUpstream() {}, close: async () => { events.push("close"); } }),
      configureP13InvitationBrowserEnvironment() {}, verifyP13InvitationBrowserOperationInfrastructure: async () => {},
      buildP13InvitationAppStage() {}, buildP13InvitationAppImage() {},
      waitForP13InvitationAppHealth: async () => { events.push("ready"); },
      verifyP13InvitationInstrumentationStage: async () => { events.push("stage"); return "p1_3_invitation_acceptance_browser_instrumentation_and_route_confirmed"; },
      withP13InvitationEnvironment: async () => { events.push("browser-boundary"); throw new Error("synthetic_stop"); },
      isBrowserDiagnosticError: () => true
    });
    await runP13InvitationBrowserCdp(context, [], "unused", mode).catch(() => {});
    expect(events).toEqual(mode === "diagnostic" ? ["ready", "stage", "close"] : ["ready", "stage", "browser-boundary", "close"]);
  });

  it("probes only the fixed runtime-assembly targets before the full disposable image", async () => {
    const targets: string[] = [];
    const { runP13InvitationBrowserCdp } = load(["runP13InvitationBrowserCdp"], {
      run: (_command: string, _args: unknown, _env: unknown, code: string) => code.endsWith("_port_failed") ? "127.0.0.1:1234" : "",
      readFileSync: () => Buffer.alloc(0),
      startP13InvitationTlsProxy: async () => ({ origin: "unused", setUpstream() {}, close: async () => {} }),
      configureP13InvitationBrowserEnvironment() {}, verifyP13InvitationBrowserOperationInfrastructure: async () => {},
      buildP13InvitationAppStage: (_context: unknown, target: string) => { targets.push(target); },
      buildP13InvitationAppImage() { throw new Error("p1_3_invitation_acceptance_browser_app_runner_filesystem_failed"); },
      isBrowserDiagnosticError: () => true
    });

    await expect(runP13InvitationBrowserCdp(context, [], "unused", "diagnostic"))
      .rejects.toThrow("p1_3_invitation_acceptance_browser_app_runner_filesystem_failed");
    expect(targets).toEqual([
      "deps", "builder", "runner-dependencies",
      "runner-public", "runner-standalone", "runner-static", "runner-runtime-artifacts", "runner-filesystem"
    ]);
  });

  it("preserves an existing CDP failure instead of collapsing it into the new-user workflow boundary", () => {
    const { p13InvitationBrowserWorkflowFailureCode } = load(["p13InvitationBrowserWorkflowFailureCode"], {
      isBrowserDiagnosticError: (error: unknown) => error instanceof Error && error.message.startsWith("p1_3_invitation_acceptance_browser_")
    });

    expect(p13InvitationBrowserWorkflowFailureCode("new_user", new Error("p1_3_invitation_acceptance_browser_cdp_failed")))
      .toBe("p1_3_invitation_acceptance_browser_cdp_failed");
    expect(p13InvitationBrowserWorkflowFailureCode("new_user", new Error("arbitrary browser failure")))
      .toBe("p1_3_invitation_acceptance_browser_new_user_failed");
  });

  it("classifies a generic new-user CDP failure at its fixed workflow stage", () => {
    const { p13InvitationNewUserWorkflowFailureCode } = load(["p13InvitationNewUserWorkflowFailureCode"], {
      isBrowserDiagnosticError: (error: unknown) => error instanceof Error && error.message.startsWith("p1_3_invitation_acceptance_browser_")
    });

    expect(p13InvitationNewUserWorkflowFailureCode("claim", new Error("p1_3_invitation_acceptance_browser_cdp_failed")))
      .toBe("p1_3_invitation_acceptance_browser_new_user_claim_failed");
    expect(p13InvitationNewUserWorkflowFailureCode("claim", new Error("p1_3_invitation_acceptance_browser_privacy_invalid")))
      .toBe("p1_3_invitation_acceptance_browser_privacy_invalid");
  });

  it("classifies a generic new-user sign-in failure at its fixed submit boundary", () => {
    const { p13InvitationNewUserSignInFailureCode } = load(["p13InvitationNewUserSignInFailureCode"], {
      isBrowserDiagnosticError: (error: unknown) => error instanceof Error && error.message.startsWith("p1_3_invitation_acceptance_browser_")
    });

    expect(p13InvitationNewUserSignInFailureCode("submit", new Error("p1_3_invitation_acceptance_browser_cdp_failed")))
      .toBe("p1_3_invitation_acceptance_browser_new_user_sign_in_submit_failed");
    expect(p13InvitationNewUserSignInFailureCode("submit", new Error("p1_3_invitation_acceptance_browser_geometry_invalid")))
      .toBe("p1_3_invitation_acceptance_browser_geometry_invalid");
  });

  it.each([
    ["recovery_generate", "p1_3_invitation_acceptance_browser_new_user_acceptance_recovery_generate_failed"],
    ["recovery_copy", "p1_3_invitation_acceptance_browser_new_user_acceptance_recovery_copy_failed"],
    ["recovery_confirm", "p1_3_invitation_acceptance_browser_new_user_acceptance_recovery_confirm_failed"],
    ["invitation_accept", "p1_3_invitation_acceptance_browser_new_user_acceptance_invitation_accept_failed"],
    ["post_accept_navigation", "p1_3_invitation_acceptance_browser_new_user_acceptance_post_accept_navigation_failed"]
  ])("classifies a generic new-user acceptance failure at fixed stage %s", (stage, code) => {
    const { p13InvitationNewUserAcceptanceFailureCode } = load(["p13InvitationNewUserAcceptanceFailureCode"], {
      isBrowserDiagnosticError: (error: unknown) => error instanceof Error && error.message.startsWith("p1_3_invitation_acceptance_browser_")
    });

    expect(p13InvitationNewUserAcceptanceFailureCode(stage, new Error("p1_3_invitation_acceptance_browser_cdp_failed"))).toBe(code);
    expect(p13InvitationNewUserAcceptanceFailureCode(stage, new Error("p1_3_invitation_acceptance_browser_privacy_invalid")))
      .toBe("p1_3_invitation_acceptance_browser_privacy_invalid");
  });

  it.each([
    ["enrollment_reserve", "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_reserve_failed"],
    ["enrollment_submit", "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_failed"],
    ["recovery_render", "p1_3_invitation_acceptance_browser_new_user_recovery_recovery_render_failed"],
    ["enrollment_unobserved", "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_unobserved_failed"],
    ["enrollment_observer_unavailable", "p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_observer_unavailable_failed"]
  ])("classifies a generic recovery-generation failure by its closed observer stage %s", async (stage, code) => {
    const { p13InvitationRecoveryGenerationFailureCode } = load(["p13InvitationRecoveryGenerationFailureCode"], {
      cdpValue: async () => stage,
      isBrowserDiagnosticError: (error: unknown) => error instanceof Error && error.message.startsWith("p1_3_invitation_acceptance_browser_")
    });

    await expect(p13InvitationRecoveryGenerationFailureCode({}, new Error("p1_3_invitation_acceptance_browser_cdp_failed"))).resolves.toBe(code);
    await expect(p13InvitationRecoveryGenerationFailureCode({}, new Error("p1_3_invitation_acceptance_browser_privacy_invalid")))
      .resolves.toBe("p1_3_invitation_acceptance_browser_privacy_invalid");
  });

  it.each([
    ["enrollment_reserve", "p1_3_invitation_acceptance_browser_existing_recipient_recovery_enrollment_reserve_failed"],
    ["enrollment_submit", "p1_3_invitation_acceptance_browser_existing_recipient_recovery_enrollment_submit_failed"],
    ["recovery_render", "p1_3_invitation_acceptance_browser_existing_recipient_recovery_recovery_render_failed"],
    ["enrollment_unobserved", "p1_3_invitation_acceptance_browser_existing_recipient_recovery_enrollment_unobserved_failed"],
    ["enrollment_observer_unavailable", "p1_3_invitation_acceptance_browser_existing_recipient_recovery_enrollment_observer_unavailable_failed"]
  ])("labels an existing-recipient recovery-generation failure with its own flow at stage %s", async (stage, code) => {
    const { p13InvitationRecoveryGenerationFailureCode } = load(["p13InvitationRecoveryGenerationFailureCode"], {
      cdpValue: async () => stage,
      isBrowserDiagnosticError: (error: unknown) => error instanceof Error && error.message.startsWith("p1_3_invitation_acceptance_browser_")
    });

    await expect(p13InvitationRecoveryGenerationFailureCode({}, new Error("p1_3_invitation_acceptance_browser_cdp_failed"), "existing_recipient")).resolves.toBe(code);
  });

  it("does not attribute absent, stale, or in-flight resource timing entries to a fingerprint failure", () => {
    const expression = p13InvitationRecoveryStageExpression();
    const stage = runInNewContext(expression, {
      performance: { getEntriesByType: () => [] },
      document: { querySelector: () => null }
    });

    expect(stage).toBe("enrollment_unobserved");
  });

  it("clears pre-action resource timings so recovery failure attribution remains action-local", () => {
    expect(source).toContain("performance.clearResourceTimings();");
    const recoveryStart = source.indexOf("async function rehearseAndAcceptP13Invitation");
    const action = source.indexOf('touchActivateP13BrowserText(client, "Generate recovery codes")', recoveryStart);
    expect(recoveryStart).toBeGreaterThanOrEqual(0);
    expect(action).toBeGreaterThan(recoveryStart);
    expect(source.indexOf("performance.clearResourceTimings();", recoveryStart)).toBeLessThan(action);
  });

  it("scrolls the recovery-generation touch target into the visual viewport before dispatch", async () => {
    const expressions: string[] = [];
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = { call: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {}; } };
    const { touchActivateP13BrowserText } = load(["touchActivateP13BrowserText"], {
      cdpValue: async (_client: unknown, expression: string) => { expressions.push(expression); return { x: 100, y: 200 }; }
    });

    await touchActivateP13BrowserText(client, "Generate recovery codes");

    expect(expressions).toHaveLength(1);
    expect(expressions[0]).toContain("scrollIntoView");
    expect(expressions[0]).toContain("rect.bottom <= innerHeight");
    expect(calls.map(({ method }) => method)).toEqual(["Input.dispatchTouchEvent", "Input.dispatchTouchEvent"]);
  });

  it("records only recovery endpoint occurrence, method, and response-status class", async () => {
    const handlers = new Map<string, (params: Record<string, unknown>) => void>();
    const calls: string[] = [];
    const client = {
      call: async (method: string) => { calls.push(method); return {}; },
      on: (method: string, handler: (params: Record<string, unknown>) => void) => {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      }
    };
    const { p13InvitationNetworkStatusClass, armP13InvitationRecoveryNetworkObserver } = load([
      "p13InvitationNetworkStatusClass", "armP13InvitationRecoveryNetworkObserver"
    ]);

    expect(p13InvitationNetworkStatusClass(204)).toBe("2xx");
    expect(p13InvitationNetworkStatusClass(0)).toBe("invalid");
    const release = await armP13InvitationRecoveryNetworkObserver(client);
    handlers.get("Network.requestWillBeSent")?.({ requestId: "synthetic-request", request: { url: "https://127.0.0.1/api/invitations/recovery/enrollment/submit", method: "POST" } });
    handlers.get("Network.responseReceived")?.({ requestId: "synthetic-request", response: { status: 503 } });
    const observed = await release();

    expect(observed).toEqual({
      reserve: { method: "absent", statusClass: "absent" },
      submit: { method: "post", statusClass: "5xx" }
    });
    expect(JSON.stringify(observed)).not.toContain("http");
    expect(calls).toEqual(["Network.enable", "Network.disable"]);
  });

  it("maps only fixed Network observation classes to recovery-generation failure codes", () => {
    const { p13InvitationRecoveryNetworkFailureCode } = load(["p13InvitationRecoveryNetworkFailureCode"]);

    expect(p13InvitationRecoveryNetworkFailureCode({
      reserve: { method: "post", statusClass: "2xx" }, submit: { method: "post", statusClass: "5xx" }
    })).toBe("p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_submit_response_5xx_failed");
    expect(p13InvitationRecoveryNetworkFailureCode({
      reserve: { method: "absent", statusClass: "absent" }, submit: { method: "absent", statusClass: "absent" }
    })).toBe("p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_network_absent_failed");
  });

  it("reports observer evaluation failure as unavailable rather than a fabricated recovery stage", async () => {
    const { p13InvitationRecoveryGenerationFailureCode } = load(["p13InvitationRecoveryGenerationFailureCode"], {
      cdpValue: async () => { throw new Error("synthetic observer failure"); },
      isBrowserDiagnosticError: () => false
    });

    await expect(p13InvitationRecoveryGenerationFailureCode({}, new Error("p1_3_invitation_acceptance_browser_cdp_failed")))
      .resolves.toBe("p1_3_invitation_acceptance_browser_new_user_recovery_enrollment_observer_unavailable_failed");
  });

  it("classifies a stalled new-user sign-in by a content-free terminal surface", () => {
    const { p13InvitationNewUserSignInSubmitTerminalFailureCode } = load(["p13InvitationNewUserSignInSubmitTerminalFailureCode"]);

    expect(p13InvitationNewUserSignInSubmitTerminalFailureCode("form_error"))
      .toBe("p1_3_invitation_acceptance_browser_new_user_sign_in_submit_form_error_unavailable");
    expect(p13InvitationNewUserSignInSubmitTerminalFailureCode("dispatch_pending"))
      .toBe("p1_3_invitation_acceptance_browser_new_user_sign_in_submit_dispatch_pending");
  });

  it("classifies a sign-in form failure by its response class without reading the body", () => {
    const { p13InvitationNewUserSignInSubmitTerminalFailureCode } = load(["p13InvitationNewUserSignInSubmitTerminalFailureCode"]);

    expect(p13InvitationNewUserSignInSubmitTerminalFailureCode("form_error", 401))
      .toBe("p1_3_invitation_acceptance_browser_new_user_sign_in_submit_form_error_unauthorized");
    expect(p13InvitationNewUserSignInSubmitTerminalFailureCode("form_error", 500))
      .toBe("p1_3_invitation_acceptance_browser_new_user_sign_in_submit_form_error_server");
  });

  it("classifies only fixed synthetic sign-in persistence postconditions", () => {
    const { p13InvitationNewUserSignInPersistenceFailureCode } = load(["p13InvitationNewUserSignInPersistenceFailureCode"]);

    expect(p13InvitationNewUserSignInPersistenceFailureCode("session_absent"))
      .toBe("p1_3_invitation_acceptance_browser_new_user_sign_in_session_absent");
    expect(p13InvitationNewUserSignInPersistenceFailureCode("session_without_event"))
      .toBe("p1_3_invitation_acceptance_browser_new_user_sign_in_session_without_event");
    expect(p13InvitationNewUserSignInPersistenceFailureCode("session_without_activity"))
      .toBe("p1_3_invitation_acceptance_browser_new_user_sign_in_session_without_activity");
    expect(p13InvitationNewUserSignInPersistenceFailureCode("session_with_activity"))
      .toBe("p1_3_invitation_acceptance_browser_new_user_sign_in_session_with_activity");
  });

  it.each(["lookup", "precheck", "handler", "failure-recording", "handler-ok", "parse", "invalid-credentials-user-not-found", "invalid-credentials-credential-account-not-found", "invalid-credentials-password-not-found", "invalid-credentials-password-mismatch", "invalid-credentials-unclassified"])("preserves only the fixed %s carrier observer value", (stage) => {
    const rmSync = vi.fn();
    const { p13InvitationCarrierFailureStage } = load(["p13InvitationCarrierFailureStage"], {
      existsSync: () => true,
      readFileSync: () => `${stage}\n`,
      rmSync
    });

    expect(p13InvitationCarrierFailureStage(context)).toBe(stage);
    expect(rmSync).toHaveBeenCalledWith(resolve("memory", "sign-in-carrier-stage"), { force: true });
  });

  it.each(["handler ", "unknown", "", "handler\nextra"])("rejects non-exact carrier observer value %j", (value) => {
    const rmSync = vi.fn();
    const { p13InvitationCarrierFailureStage } = load(["p13InvitationCarrierFailureStage"], {
      existsSync: () => true,
      readFileSync: () => `${value}\n`,
      rmSync
    });

    expect(p13InvitationCarrierFailureStage(context)).toBe("unreadable");
    expect(rmSync).toHaveBeenCalledWith(resolve("memory", "sign-in-carrier-stage"), { force: true });
  });

  it("reports an unreadable marker instead of absence when read-boundary consumption fails", () => {
    const { p13InvitationCarrierFailureStage } = load(["p13InvitationCarrierFailureStage"], {
      existsSync: () => true,
      readFileSync: () => "lookup\n",
      rmSync: () => { throw new Error("unavailable"); }
    });

    expect(p13InvitationCarrierFailureStage(context)).toBe("unreadable");
  });

  it.each([
    ["lookup", "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_lookup"],
    ["precheck", "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_precheck"],
    ["handler", "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_handler"],
    ["failure-recording", "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_failure_recording"]
  ])("prefers fixed carrier stage %s over the less specific absent-session result", (stage, code) => {
    const { p13InvitationNewUserSignInPersistenceFailureCode } = load(["p13InvitationNewUserSignInPersistenceFailureCode"]);

    expect(p13InvitationNewUserSignInPersistenceFailureCode("session_absent", stage)).toBe(code);
  });

  it.each(["session_without_event", "session_without_activity", "session_with_activity"])("does not read the carrier marker for %s", (state) => {
    const p13InvitationCarrierFailureStage = vi.fn();
    const { p13InvitationNewUserSignInPostconditionFailureCode } = load(["p13InvitationNewUserSignInPostconditionFailureCode"], {
      p13InvitationNewUserSignInPersistenceState: () => state,
      p13InvitationCarrierFailureStage,
      p13InvitationNewUserSignInPersistenceFailureCode: (value: string) => `fixed_${value}`
    });

    expect(p13InvitationNewUserSignInPostconditionFailureCode(context, {})).toBe(`fixed_${state}`);
    expect(p13InvitationCarrierFailureStage).not.toHaveBeenCalled();
  });

  it("reads the carrier marker only after the session_absent branch", () => {
    const events: string[] = [];
    const { p13InvitationNewUserSignInPostconditionFailureCode } = load(["p13InvitationNewUserSignInPostconditionFailureCode"], {
      p13InvitationNewUserSignInPersistenceState: () => { events.push("session_absent"); return "session_absent"; },
      p13InvitationCarrierFailureStage: () => { events.push("lookup"); return "lookup"; },
      p13InvitationNewUserSignInPersistenceFailureCode: (_value: string, stage: string) => `fixed_${stage}`
    });

    expect(p13InvitationNewUserSignInPostconditionFailureCode(context, {})).toBe("fixed_lookup");
    expect(events).toEqual(["session_absent", "lookup"]);
  });

  it("preserves fixed sign-in persistence classifications through the browser boundary", () => {
    for (const code of [
      "p1_3_invitation_acceptance_browser_new_user_sign_in_postcondition_probe_failed",
      "p1_3_invitation_acceptance_browser_new_user_sign_in_session_absent",
      "p1_3_invitation_acceptance_browser_new_user_sign_in_session_without_event",
      "p1_3_invitation_acceptance_browser_new_user_sign_in_session_without_activity",
      "p1_3_invitation_acceptance_browser_new_user_sign_in_session_with_activity"
    ]) expect(source).toContain(`"${code}"`);
    for (const stage of ["lookup", "precheck", "handler", "failure_recording", "handler_ok"]) {
      expect(source).toContain(`"p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_${stage}"`);
    }
  });

  it("reports no carrier marker only when the marker file is absent", () => {
    const { p13InvitationCarrierFailureStage } = load(["p13InvitationCarrierFailureStage"], {
      existsSync: () => false,
      readFileSync: () => { throw new Error("must not read"); },
      rmSync: () => { throw new Error("must not remove"); }
    });

    expect(p13InvitationCarrierFailureStage(context)).toBeUndefined();
  });

  it("keeps unreadable carrier markers distinct from absent positive controls and fixed stage codes", () => {
    for (const code of [
      "p1_3_invitation_acceptance_browser_positive_control_unreadable",
      "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_unreadable",
      "p1_3_invitation_acceptance_browser_new_user_sign_in_carrier_unreadable"
    ]) expect(source).toContain(`"${code}"`);
    expect(source).toContain('if (positiveControl === "unreadable") throw new Error("p1_3_invitation_acceptance_browser_positive_control_unreadable");');
  });

  it("returns the existing-recipient denial probe category through a fixed observation with its own failure code", () => {
    expect(source).toContain("p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_probe_failed: /^(?:credential_account_absent|session_created|throttle_quiet|failure_recorded_only|no_evidence)$/");
    expect(source).toContain('context.env, "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_probe_failed")');
    expect(source).not.toContain('context.env, "p1_3_invitation_acceptance_browser_existing_recipient_sign_in_denial_no_evidence")');
    for (const stage of ["handler_ok", "parse", "invalid_credentials_user_not_found", "invalid_credentials_credential_account_not_found", "invalid_credentials_password_not_found", "invalid_credentials_password_mismatch", "invalid_credentials_unclassified"]) {
      expect(source).toContain(`"p1_3_invitation_acceptance_browser_existing_recipient_sign_in_carrier_${stage}"`);
    }
  });

  it("executes the generated sign-in response-status expression in the browser JavaScript boundary", () => {
    const expression = p13InvitationSignInStatusExpression();
    const status = runInNewContext(expression, {
      performance: {
        getEntriesByType: () => [{ name: "https://127.0.0.1:1234/api/auth/sign-in/email", responseStatus: 401 }]
      }
    });

    expect(status).toBe(401);
  });

  it("waits through slow startup instead of rejecting an early snapshot", async () => {
    vi.useFakeTimers();
    let ready = false;
    const request = vi.fn(async () => ready ? 204 : 502);
    const { waitForP13InvitationAppHealth, p13InvitationAppHealthFailureCode } = load([
      "waitForP13InvitationAppHealth", "p13InvitationAppHealthFailureCode"
    ], { p13InvitationTlsStatus: request, p13InvitationAppStartupFailureCode: () => ready ? "" : "p1_3_invitation_acceptance_browser_app_migration_incomplete", setTimeout, clearTimeout });
    expect(p13InvitationAppHealthFailureCode(502)).toContain("tls_proxy_upstream_error");
    const result = waitForP13InvitationAppHealth(context, "https://127.0.0.1:1234");
    const assertion = expect(result).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    ready = true;
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(request.mock.calls.length).toBeGreaterThan(1);
  });
});
