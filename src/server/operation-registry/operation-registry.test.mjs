import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";

const {
  createProgramFromSources,
  checkRepositoryArtifacts,
  checkRegistryCompletion,
  checkGeneratedArtifacts,
  buildDeferredGateRegistry,
  buildRepositoryArtifacts,
  buildRepositoryRegistry,
  computeRegistryDigest,
  computeRuntimeInvocationLedgerDigest,
  computeStructuralFingerprint,
  discoverClientBindings,
  discoverContainerCommandBindings,
  discoverPackageCommands,
  discoverRouteBindings,
  discoverServerActions,
  discoverServerLoaderBindings,
  discoverStructuralExclusions,
  discoverWorkerWiring,
  renderGeneratedArtifacts,
  validateStructuralFingerprint,
  validateGateEvidenceIntegrity,
  loadRepositoryProgram,
  parseSidecarSource
} = await import(new URL("./checker.ts", import.meta.url).href);

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const validBody = `{
  schemaVersion: 1,
  id: "test",
  ownerModule: "src/app/api/test/route.ts",
  ownerKind: "api_route",
  bindings: [],
  disposition: "observed",
  deferredGateIds: []
}`;

const tests = [];
let declarationFamilyRegistry;

function test(name, run) {
  tests.push({ name, run });
}

function assertDeclarationFamily(sidecarPaths) {
  const required = new Set(sidecarPaths);
  const registry = declarationFamilyRegistry ??= buildRepositoryRegistry(repositoryRoot);
  assert.deepEqual(registry.diagnostics, []);

  const declared = new Set(
    registry.declarations.map((entry) => entry.sidecarPath)
  );
  for (const sidecarPath of required) assert.ok(declared.has(sidecarPath));
  assert.deepEqual(
    registry.omissionLedger.filter((entry) => required.has(entry.sidecarPath)),
    []
  );
}

function textWithLineEnding(text, lineEnding) {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, lineEnding);
}

function writeCrossEolRepositoryFixture(root, lineEnding) {
  const writeFixture = (file, content) => {
    const target = resolve(root, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, textWithLineEnding(content, lineEnding));
  };
  writeFixture(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext" },
      include: ["src/**/*.ts"]
    }) + "\n"
  );
  writeFixture("package.json", `${JSON.stringify({ scripts: { tool: "tsx src/app/route.ts" } }, null, 2)}\n`);
  writeFixture(
    "src/app/route.ts",
    "\nexport function GET() { return new Response(\"canonical\"); }\n"
  );
  writeFixture(
    "src/app/route.operation.ts",
    `import type { OperationDeclaration } from "@/server/operation-registry/schema";

export const operation = {
  schemaVersion: 1,
  id: "api_route:src/app/route.ts",
  ownerModule: "src/app/route.ts",
  ownerKind: "api_route",
  bindings: [{ kind: "route_method", symbol: "GET", target: "src/app/route.ts#GET" }],
  disposition: "observed",
  deferredGateIds: []
} as const satisfies OperationDeclaration;
`
  );
  for (const file of [
    "src/server/operation-registry/checker.ts",
    "src/server/operation-registry/schema.ts",
    "scripts/operation-registry.ts"
  ]) {
    writeFixture(file, readFileSync(resolve(repositoryRoot, file), "utf8"));
  }
  return writeFixture;
}

test("canonicalizes LF and CRLF repository text before generating anchors and digests", () => {
  const lfRoot = mkdtempSync(resolve(tmpdir(), "cubby-cross-eol-lf-"));
  const crlfRoot = mkdtempSync(resolve(tmpdir(), "cubby-cross-eol-crlf-"));
  try {
    writeCrossEolRepositoryFixture(lfRoot, "\n");
    writeCrossEolRepositoryFixture(crlfRoot, "\r\n");
    const lf = buildRepositoryArtifacts(lfRoot);
    const crlf = buildRepositoryArtifacts(crlfRoot);

    assert.deepEqual(crlf.artifacts, lf.artifacts);
    assert.deepEqual(
      {
        schemaDigest: crlf.schemaDigest,
        generatorDigest: crlf.generatorDigest,
        ownerSetDigest: crlf.ownerSetDigest,
        observationDigest: crlf.observationDigest,
        declarationDigest: crlf.declarationDigest,
        runtimeInvocationLedgerDigest: crlf.runtimeInvocationLedgerDigest,
        registryDigest: crlf.registryDigest
      },
      {
        schemaDigest: lf.schemaDigest,
        generatorDigest: lf.generatorDigest,
        ownerSetDigest: lf.ownerSetDigest,
        observationDigest: lf.observationDigest,
        declarationDigest: lf.declarationDigest,
        runtimeInvocationLedgerDigest: lf.runtimeInvocationLedgerDigest,
        registryDigest: lf.registryDigest
      }
    );
    const lfObservation = JSON.parse(
      lf.artifacts["src/server/operation-registry/generated/observation-registry.json"]
    );
    const crlfObservation = JSON.parse(
      crlf.artifacts["src/server/operation-registry/generated/observation-registry.json"]
    );
    assert.deepEqual(crlfObservation.observationCanonical, lfObservation.observationCanonical);
  } finally {
    rmSync(lfRoot, { recursive: true, force: true });
    rmSync(crlfRoot, { recursive: true, force: true });
  }
});

test("accepts CRLF-translated generated artifacts when canonical content matches", () => {
  const lfRoot = mkdtempSync(resolve(tmpdir(), "cubby-cross-eol-artifacts-lf-"));
  const crlfRoot = mkdtempSync(resolve(tmpdir(), "cubby-cross-eol-artifacts-crlf-"));
  try {
    writeCrossEolRepositoryFixture(lfRoot, "\n");
    const writeCrLfFixture = writeCrossEolRepositoryFixture(crlfRoot, "\r\n");
    const lf = buildRepositoryArtifacts(lfRoot);
    for (const [file, content] of Object.entries(lf.artifacts)) {
      writeCrLfFixture(file, content);
    }
    const crlf = buildRepositoryArtifacts(crlfRoot);
    assert.deepEqual(
      checkGeneratedArtifacts(
        crlfRoot,
        lf.artifacts,
        new Set(crlf.registry.declarations.map((entry) => entry.sidecarPath))
      ).filter((diagnostic) => diagnostic.code === "generated_artifact_mismatch"),
      []
    );
  } finally {
    rmSync(lfRoot, { recursive: true, force: true });
    rmSync(crlfRoot, { recursive: true, force: true });
  }
});

test("preserves logical source drift across canonical LF and CRLF repository text", () => {
  const lfRoot = mkdtempSync(resolve(tmpdir(), "cubby-cross-eol-drift-lf-"));
  const crlfRoot = mkdtempSync(resolve(tmpdir(), "cubby-cross-eol-drift-crlf-"));
  try {
    const writeLfFixture = writeCrossEolRepositoryFixture(lfRoot, "\n");
    const writeCrLfFixture = writeCrossEolRepositoryFixture(
      crlfRoot,
      String.fromCharCode(13) + "\n"
    );
    const baseline = buildRepositoryArtifacts(lfRoot);
    const changedRoute = "\nexport function GET() { return new Response(\"changed\"); }\n";
    writeLfFixture("src/app/route.ts", changedRoute);
    writeCrLfFixture("src/app/route.ts", changedRoute);
    const changedLf = buildRepositoryArtifacts(lfRoot);
    const changedCrlf = buildRepositoryArtifacts(crlfRoot);

    assert.deepEqual(changedCrlf.artifacts, changedLf.artifacts);
    assert.notEqual(changedLf.registryDigest, baseline.registryDigest);
  } finally {
    rmSync(lfRoot, { recursive: true, force: true });
    rmSync(crlfRoot, { recursive: true, force: true });
  }
});

test("rejects every executable or non-literal sidecar form", () => {
    const invalidSources = [
      `import { value } from "@/server/services/example"; export const operation = ${validBody} as const;`,
      `import type { OperationDeclaration } from "@/server/operation-registry/schema"; const base = ${validBody}; export const operation = { ...base } as const satisfies OperationDeclaration;`,
      `import type { OperationDeclaration } from "@/server/operation-registry/schema"; export const operation = { ...${validBody}, ["id"]: "computed" } as const satisfies OperationDeclaration;`,
      `import type { OperationDeclaration } from "@/server/operation-registry/schema"; export function operation() { return ${validBody}; }`,
      `import { env } from "@/lib/env"; export const operation = ${validBody} as const;`,
      `import type { OperationDeclaration } from "@/server/operation-registry/schema"; export const operation = import("@/server/services/example") satisfies OperationDeclaration;`,
      `import type { OperationDeclaration } from "@/server/operation-registry/schema"; export const operation = makeOperation() satisfies OperationDeclaration;`
    ];

    for (const [index, source] of invalidSources.entries()) {
      const parsed = parseSidecarSource(`invalid-${index}.operation.ts`, source);
      assert.ok(
        parsed.diagnostics.some(
          (diagnostic) => diagnostic.code === "unsupported_sidecar_syntax"
        )
      );
    }
});

test("enumerates registry-tree sidecars and requires the exact schema type import", () => {
  const roguePath = resolve(
    repositoryRoot,
    "src/server/operation-registry/rogue-fixture.operation.ts"
  );
  writeFileSync(
    roguePath,
    `import { execute } from "@/server/services/example";\nexport const operation = execute();\n`
  );
  try {
    const registry = buildRepositoryRegistry(repositoryRoot);
    assert.ok(
      registry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "extra_sidecar" &&
          diagnostic.file === "src/server/operation-registry/rogue-fixture.operation.ts"
      ),
      "registry-tree rogue sidecar must be enumerated"
    );
    assert.ok(
      registry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_sidecar_syntax" &&
          diagnostic.file === "src/server/operation-registry/rogue-fixture.operation.ts"
      ),
      "rogue sidecar syntax must still be parsed fail-closed"
    );
  } finally {
    unlinkSync(roguePath);
  }

  for (const [name, moduleName] of [
    ["prefix", "@/server/operation-registry/schema-extra"],
    ["traversal", "@/server/operation-registry/../services/example"]
  ]) {
    const parsed = parseSidecarSource(
      `${name}.operation.ts`,
      `import type { OperationDeclaration } from "${moduleName}"; export const operation = ${validBody} as const satisfies OperationDeclaration;`
    );
    assert.ok(
      parsed.diagnostics.some(
        (diagnostic) => diagnostic.code === "unsupported_sidecar_syntax"
      ),
      `${name} schema import must fail closed`
    );
  }
});

test("discovers distinct multi-method and Better Auth route symbols", () => {
  const owners = [
    "src/app/api/activities/route.ts",
    "src/app/api/auth/[...all]/route.ts"
  ];
  const program = loadRepositoryProgram(repositoryRoot, owners);
  const result = discoverRouteBindings(program, repositoryRoot, owners);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.observations.map(({ ownerModule, symbol, target }) => ({
      ownerModule,
      symbol,
      target
    })),
    [
      {
        ownerModule: "src/app/api/activities/route.ts",
        symbol: "GET",
        target: "src/app/api/activities/route.ts#GET"
      },
      {
        ownerModule: "src/app/api/activities/route.ts",
        symbol: "POST",
        target: "src/app/api/activities/route.ts#POST"
      },
      {
        ownerModule: "src/app/api/auth/[...all]/route.ts",
        symbol: "GET",
        target: "better-auth/next-js#toNextJsHandler.GET"
      },
      {
        ownerModule: "src/app/api/auth/[...all]/route.ts",
        symbol: "POST",
        target: "src/app/api/auth/[...all]/route.ts#POST"
      }
    ]
  );
});

test("enumerates root and nested routes independently and rejects unsupported route extensions", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-route-discovery-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", jsx: "preserve" }, include: ["src/**/*.ts", "src/**/*.tsx"] })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture("src/app/route.ts", "export function GET() {}\n");
    writeFixture("src/app/nested/route.tsx", "export function POST() {}\n");
    for (const extension of ["js", "jsx", "mjs", "cjs", "coffee"]) {
      writeFixture(`src/app/unsupported-${extension}/route.${extension}`, "export function GET() {}\n");
    }

    const registry = buildRepositoryRegistry(temporaryRoot);
    assert.deepEqual(
      registry.owners
        .filter((owner) => owner.ownerKind === "api_route")
        .map((owner) => owner.ownerModule),
      ["src/app/nested/route.tsx", "src/app/route.ts"]
    );
    assert.deepEqual(
      registry.diagnostics
        .filter((diagnostic) => diagnostic.code === "unsupported_route_extension")
        .map((diagnostic) => diagnostic.file)
        .sort(),
      ["cjs", "coffee", "js", "jsx", "mjs"].map(
        (extension) => `src/app/unsupported-${extension}/route.${extension}`
      ).sort()
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("declares representative multi-method and Better Auth route sidecars", () => {
  const required = new Set([
    "src/app/api/activities/route.operation.ts",
    "src/app/api/auth/[...all]/route.operation.ts"
  ]);
  const registry = buildRepositoryRegistry(repositoryRoot, required);
  assert.deepEqual(registry.diagnostics, []);
  const declared = new Set(registry.declarations.map((entry) => entry.sidecarPath));
  for (const sidecar of required) assert.ok(declared.has(sidecar));
});

test("declares the remaining activity route family", () => {
  assertDeclarationFamily([
    "src/app/api/activities/[id]/route.operation.ts",
    "src/app/api/activities/undo-last/route.operation.ts"
  ]);
});

test("declares the baby route family", () => {
  assertDeclarationFamily([
    "src/app/api/babies/[id]/deactivate/route.operation.ts",
    "src/app/api/babies/[id]/reactivate/route.operation.ts",
    "src/app/api/babies/route.operation.ts"
  ]);
});

test("declares the backup and import route family", () => {
  assertDeclarationFamily([
    "src/app/api/backups/export/route.operation.ts",
    "src/app/api/backups/local/[filename]/route.operation.ts",
    "src/app/api/backups/restore/preview/route.operation.ts",
    "src/app/api/backups/restore/route.operation.ts",
    "src/app/api/backups/route.operation.ts",
    "src/app/api/backups/sprout/import/route.operation.ts",
    "src/app/api/backups/sprout/preview/route.operation.ts"
  ]);
});

test("declares the dashboard warning route family", () => {
  assertDeclarationFamily([
    "src/app/api/dashboard/warnings/dismiss/route.operation.ts"
  ]);
});

test("declares the activity export route family", () => {
  assertDeclarationFamily([
    "src/app/api/export/activities.csv/route.operation.ts",
    "src/app/api/export/activities.tsv/route.operation.ts"
  ]);
});

test("declares the health route family", () => {
  assertDeclarationFamily([
    "src/app/api/health/route.operation.ts"
  ]);
});

test("declares the hook integration route family", () => {
  assertDeclarationFamily([
    "src/app/api/hooks/v1/babies/[babyId]/activities/route.operation.ts",
    "src/app/api/hooks/v1/babies/[babyId]/measurements/latest/route.operation.ts",
    "src/app/api/hooks/v1/babies/[babyId]/reference/route.operation.ts",
    "src/app/api/hooks/v1/babies/[babyId]/status/route.operation.ts",
    "src/app/api/hooks/v1/babies/route.operation.ts"
  ]);
});

test("declares the household member lifecycle route family", () => {
  assertDeclarationFamily([
    "src/app/api/households/leave/route.operation.ts",
    "src/app/api/members/[id]/restore/route.operation.ts",
    "src/app/api/members/[id]/route.operation.ts",
    "src/app/api/members/[id]/suspend/route.operation.ts"
  ]);
});

test("declares the invite route family", () => {
  assertDeclarationFamily([
    "src/app/api/invites/[token]/accept/route.operation.ts",
    "src/app/api/invites/[token]/revoke/route.operation.ts",
    "src/app/api/invites/revoke-all/route.operation.ts",
    "src/app/api/invites/route.operation.ts"
  ]);
});

test("declares the notification route family", () => {
  assertDeclarationFamily([
    "src/app/api/notifications/preferences/route.operation.ts",
    "src/app/api/notifications/subscribe/route.operation.ts"
  ]);
});

test("declares the onboarding route family", () => {
  assertDeclarationFamily([
    "src/app/api/onboarding/route.operation.ts"
  ]);
});

test("declares the remaining settings route family", () => {
  assertDeclarationFamily([
    "src/app/api/settings/api-keys/[id]/revoke/route.operation.ts",
    "src/app/api/settings/api-keys/route.operation.ts",
    "src/app/api/settings/appearance/route.operation.ts",
    "src/app/api/settings/units/route.operation.ts",
    "src/app/api/settings/webhooks/[id]/route.operation.ts",
    "src/app/api/settings/webhooks/route.operation.ts"
  ]);
});

test("declares the timer lifecycle route family", () => {
  assertDeclarationFamily([
    "src/app/api/timers/[id]/pause/route.operation.ts",
    "src/app/api/timers/[id]/resume/route.operation.ts",
    "src/app/api/timers/[id]/stop/route.operation.ts"
  ]);
});

test("declares the activity detail loader family", () => {
  assertDeclarationFamily([
    "src/app/app/activities/[id]/edit/page.operation.ts",
    "src/app/app/activities/[id]/page.operation.ts"
  ]);
});

test("declares the primary authenticated loader family", () => {
  assertDeclarationFamily([
    "src/app/app/babies/page.operation.ts",
    "src/app/app/history/page.operation.ts",
    "src/app/app/layout.operation.ts",
    "src/app/app/log/[type]/page.operation.ts",
    "src/app/app/nursery/page.operation.ts",
    "src/app/app/page.operation.ts",
    "src/app/app/reports/page.operation.ts"
  ]);
});

test("declares the settings loader family", () => {
  assertDeclarationFamily([
    "src/app/app/settings/appearance/page.operation.ts",
    "src/app/app/settings/backups/page.operation.ts",
    "src/app/app/settings/export/page.operation.ts",
    "src/app/app/settings/integrations/page.operation.ts",
    "src/app/app/settings/leave/page.operation.ts",
    "src/app/app/settings/members/page.operation.ts",
    "src/app/app/settings/notifications/page.operation.ts",
    "src/app/app/settings/page.operation.ts",
    "src/app/app/settings/sessions/page.operation.ts",
    "src/app/app/settings/units/page.operation.ts"
  ]);
});

test("declares the public and platform loader family", () => {
  assertDeclarationFamily([
    "src/app/invite/[token]/page.operation.ts",
    "src/app/login/page.operation.ts",
    "src/app/onboarding/page.operation.ts",
    "src/app/page.operation.ts",
    "src/app/platform/settings/page.operation.ts",
    "src/app/register/page.operation.ts"
  ]);
});

test("declares the client action control family", () => {
  assertDeclarationFamily([
    "src/components/actions/accept-invite-button.operation.ts",
    "src/components/actions/activity-actions.operation.ts",
    "src/components/actions/baby-lifecycle-button.operation.ts",
    "src/components/actions/confirmed-activity-delete.operation.ts"
  ]);
});

test("declares the daily workflow client family", () => {
  assertDeclarationFamily([
    "src/components/dashboard/dashboard-warnings.operation.ts",
    "src/components/forms/activity-form.operation.ts",
    "src/components/forms/baby-form.operation.ts",
    "src/components/forms/invite-form.operation.ts",
    "src/components/forms/onboarding-form.operation.ts"
  ]);
});

test("declares the remaining settings client family", () => {
  assertDeclarationFamily([
    "src/components/settings/appearance-form.operation.ts",
    "src/components/settings/backup-download-button.operation.ts",
    "src/components/settings/backup-restore-form.operation.ts",
    "src/components/settings/integration-forms.operation.ts",
    "src/components/settings/leave-household-form.operation.ts",
    "src/components/settings/member-access-manager.operation.ts",
    "src/components/settings/notification-preference-form.operation.ts",
    "src/components/settings/sprout-restore-form.operation.ts",
    "src/components/settings/unit-preferences-form.operation.ts"
  ]);
});

test("declares the remaining worker family", () => {
  assertDeclarationFamily([
    "src/server/integrity-scheduler.operation.ts",
    "src/server/sprout-source-retention-scheduler.operation.ts"
  ]);
});

test("declares the remaining TypeScript package command family", () => {
  assertDeclarationFamily([
    "prisma/seed.operation.ts",
    "scripts/backup-recovery-rehearsal.operation.ts",
    "scripts/integrity-check.operation.ts",
    "scripts/sprout-preview-commit.acceptance-rehearsal.operation.ts",
    "scripts/update-preflight.operation.ts"
  ]);
});

test("resolves route aliases, renamed exports, and export-star targets exactly", () => {
  const owners = [
    "src/app/api/platform/registration/route.ts",
    "src/app/api/settings/registration/route.ts"
  ];
  const program = loadRepositoryProgram(repositoryRoot, owners);
  const actual = discoverRouteBindings(program, repositoryRoot, owners);
  assert.deepEqual(actual.diagnostics, []);
  assert.deepEqual(
    actual.observations
      .filter((entry) => entry.ownerModule === owners[1])
      .map(({ symbol, target }) => ({ symbol, target })),
    [
      { symbol: "GET", target: `${owners[0]}#GET` },
      { symbol: "POST", target: `${owners[0]}#POST` },
      { symbol: "PUT", target: `${owners[0]}#PUT` }
    ]
  );

  const fixtureRoot = resolve(repositoryRoot, "src/server/operation-registry-fixture");
  const fixtureProgram = createProgramFromSources(fixtureRoot, {
    "canonical.ts": "export function GET() {} export function POST() {}",
    "barrel.ts": 'export * from "./canonical";',
    "renamed.ts": 'export { GET as HEAD } from "./canonical";',
    "wrapped.ts": "const handler = () => undefined; export const GET = wrap(handler);"
  });
  const fixture = discoverRouteBindings(fixtureProgram, fixtureRoot, [
    "barrel.ts",
    "renamed.ts",
    "wrapped.ts"
  ]);
  assert.deepEqual(
    fixture.observations.map(({ ownerModule, symbol, target }) => ({
      ownerModule,
      symbol,
      target
    })),
    [
      { ownerModule: "barrel.ts", symbol: "GET", target: "canonical.ts#GET" },
      { ownerModule: "barrel.ts", symbol: "POST", target: "canonical.ts#POST" },
      { ownerModule: "renamed.ts", symbol: "HEAD", target: "canonical.ts#GET" }
    ]
  );
  assert.ok(
    fixture.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unresolved_entrypoint" &&
        diagnostic.file === "wrapped.ts"
    )
  );
});

test("declares canonical and public registration alias sidecars", () => {
  const required = new Set([
    "src/app/api/platform/registration/route.operation.ts",
    "src/app/api/settings/registration/route.operation.ts"
  ]);
  const registry = buildRepositoryRegistry(repositoryRoot, required);
  assert.deepEqual(registry.diagnostics, []);
  const declared = new Set(registry.declarations.map((entry) => entry.sidecarPath));
  for (const sidecar of required) assert.ok(declared.has(sidecar));
});

test("discovers module-level and inline Server Actions without collapsing identity", () => {
  const owner = "src/app/app/calendar/actions.ts";
  const program = loadRepositoryProgram(repositoryRoot, [owner]);
  const actual = discoverServerActions(program, repositoryRoot, [owner]);
  assert.deepEqual(actual.diagnostics, []);
  assert.deepEqual(
    actual.observations.map(({ symbol, target }) => ({ symbol, target })),
    [
      {
        symbol: "createCalendarEventAction",
        target: `${owner}#createCalendarEventAction`
      }
    ]
  );

  const fixtureRoot = resolve(repositoryRoot, "src/server/operation-registry-action-fixture");
  const fixtureProgram = createProgramFromSources(fixtureRoot, {
    "module.ts": '"use server"; export async function moduleAction() {}',
    "prologue.ts": '"use strict"; "use server"; export async function prologueAction() {}',
    "inline.ts": 'export async function inlineAction() { "use server"; }',
    "local.ts": 'const localAction = async () => { "use server"; }; export { localAction };',
    "wrapped.ts": 'export const wrapped = wrap(async () => { "use server"; });'
  });
  const fixture = discoverServerActions(fixtureProgram, fixtureRoot, [
    "module.ts",
    "prologue.ts",
    "inline.ts",
    "local.ts",
    "wrapped.ts"
  ]);
  assert.deepEqual(
    fixture.observations.map(({ ownerModule, symbol }) => ({ ownerModule, symbol })),
    [
      { ownerModule: "module.ts", symbol: "moduleAction" },
      { ownerModule: "prologue.ts", symbol: "prologueAction" },
      { ownerModule: "inline.ts", symbol: "inlineAction" },
      { ownerModule: "local.ts", symbol: "localAction" }
    ]
  );
  assert.ok(
    fixture.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unsupported_server_action" &&
        diagnostic.file === "wrapped.ts"
    )
  );
});

test("discovers exported and re-exported Server Actions outside src/app", () => {
  const fixtureRoot = resolve(repositoryRoot, "src/server/operation-registry-action-reexport-fixture");
  const fixtureProgram = createProgramFromSources(fixtureRoot, {
    "implementation.ts": "export async function actualAction() {} export const notAnAction = 1;",
    "actions.ts": '"use server"; export { actualAction as renamedAction } from "./implementation";',
    "local.ts": '"use server"; async function localAction() {} export { localAction as publicAction };',
    "inline.ts": 'export const outsideInlineAction = async () => { "use server"; };',
    "unsupported.ts": '"use server"; export { notAnAction } from "./implementation";'
  });
  const owners = ["actions.ts", "local.ts", "inline.ts", "unsupported.ts"];
  const fixture = discoverServerActions(fixtureProgram, fixtureRoot, owners);
  assert.deepEqual(
    fixture.observations.map(({ ownerModule, symbol, target }) => ({ ownerModule, symbol, target })),
    [
      {
        ownerModule: "actions.ts",
        symbol: "renamedAction",
        target: "implementation.ts#actualAction"
      },
      {
        ownerModule: "local.ts",
        symbol: "publicAction",
        target: "local.ts#localAction"
      },
      {
        ownerModule: "inline.ts",
        symbol: "outsideInlineAction",
        target: "inline.ts#outsideInlineAction"
      }
    ]
  );
  assert.ok(
    fixture.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unsupported_server_action" &&
        diagnostic.file === "unsupported.ts"
    )
  );

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-action-candidates-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext" }, include: ["src/**/*.ts", "src/**/*.tsx"] })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture(
      "src/features/outside-action.ts",
      'export async function outsideAction() { "use server"; }\n'
    );
    const registry = buildRepositoryRegistry(temporaryRoot);
    assert.ok(
      registry.owners.some(
        (owner) =>
          owner.ownerKind === "server_action" &&
          owner.ownerModule === "src/features/outside-action.ts"
      ),
      "Server Action candidates must not be scoped to src/app"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("discovers server-loader value imports and excludes type-only imports", () => {
  const owner = "src/app/app/calendar/page.tsx";
  const program = loadRepositoryProgram(repositoryRoot, [owner]);
  const actual = discoverServerLoaderBindings(program, repositoryRoot, [owner]);
  assert.deepEqual(actual.diagnostics, []);
  assert.deepEqual(
    actual.observations.map(({ symbol, target }) => ({ symbol, target })),
    [
      {
        symbol: "requireUserPage",
        target: "src/server/auth/session.ts#requireUserPage"
      },
      {
        symbol: "getHeaderBabySelector",
        target: "src/server/services/baby-selector.ts#getHeaderBabySelector"
      },
      {
        symbol: "getCalendar",
        target: "src/server/services/calendar.ts#getCalendar"
      },
      {
        symbol: "createCalendarEvent",
        target: "src/server/services/calendar.ts#createCalendarEvent"
      }
    ]
  );

  const fixtureProgram = createProgramFromSources(repositoryRoot, {
    "src/server/loader-fixture.ts":
      "export type Shape = { id: string }; export function load() {} export function direct() {}",
    "src/app/loader-fixture/page.tsx":
      'import { load as aliased, direct, type Shape } from "@/server/loader-fixture"; import type { load as typeOnlyLoad } from "@/server/loader-fixture"; void aliased; void direct; type Used = Shape;'
  });
  const fixture = discoverServerLoaderBindings(fixtureProgram, repositoryRoot, [
    "src/app/loader-fixture/page.tsx"
  ]);
  assert.deepEqual(fixture.diagnostics, []);
  assert.deepEqual(
    fixture.observations.map(({ symbol, target }) => ({ symbol, target })),
    [
      {
        symbol: "aliased",
        target: "src/server/loader-fixture.ts#load"
      },
      {
        symbol: "direct",
        target: "src/server/loader-fixture.ts#direct"
      }
    ]
  );
});

test("resolves loader aliases relative paths and barrels before server classification", () => {
  const fixtureProgram = createProgramFromSources(repositoryRoot, {
    "src/server/loader-target.ts":
      "export function loadFromServer() {} export type ServerShape = { id: string };",
    "src/lib/db/prisma.ts": "export const database = {};",
    "src/shared/server-barrel.ts":
      'export { loadFromServer as barrelLoad } from "../server/loader-target";',
    "src/shared/db-barrel.ts": 'export { database } from "../lib/db/prisma";',
    "src/app/loader-resolution/page.tsx":
      'import { barrelLoad as fromBarrel } from "@/shared/server-barrel"; import { loadFromServer as fromRelative, type ServerShape } from "../../server/loader-target"; import { database as dbFromBarrel } from "@/shared/db-barrel"; import { missing } from "@/server/missing"; void fromBarrel; void fromRelative; void dbFromBarrel; void missing; type Used = ServerShape;'
  });
  const owner = "src/app/loader-resolution/page.tsx";
  const fixture = discoverServerLoaderBindings(fixtureProgram, repositoryRoot, [owner]);
  assert.deepEqual(
    fixture.observations.map(({ symbol, target }) => ({ symbol, target })),
    [
      { symbol: "fromBarrel", target: "src/server/loader-target.ts#loadFromServer" },
      { symbol: "fromRelative", target: "src/server/loader-target.ts#loadFromServer" },
      { symbol: "dbFromBarrel", target: "src/lib/db/prisma.ts#database" }
    ]
  );
  assert.deepEqual(
    fixture.diagnostics.map(({ code, detail }) => ({ code, detail })),
    [
      {
        code: "unresolved_loader_import",
        detail: "unresolved_value_import:missing"
      }
    ]
  );
});

test("declares representative calendar action and loader sidecars", () => {
  const required = new Set([
    "src/app/app/calendar/actions.operation.ts",
    "src/app/app/calendar/page.operation.ts"
  ]);
  const registry = buildRepositoryRegistry(repositoryRoot, required);
  assert.deepEqual(registry.diagnostics, []);
  const declared = new Set(registry.declarations.map((entry) => entry.sidecarPath));
  for (const sidecar of required) assert.ok(declared.has(sidecar));
});

test("discovers fetch, form, imported action, and Better Auth callers exactly", () => {
  const owners = [
    "src/app/app/calendar/page.tsx",
    "src/components/settings/registration-settings-form.tsx",
    "src/components/auth/auth-form.tsx",
    "src/components/sign-out-button.tsx",
    "src/components/settings/session-manager.tsx"
  ];
  const program = loadRepositoryProgram(repositoryRoot, owners);
  const actual = discoverClientBindings(program, repositoryRoot, owners);
  assert.deepEqual(actual.diagnostics, []);
  assert.deepEqual(
    actual.observations.map(({ ownerModule, kind, symbol, target }) => ({
      ownerModule,
      kind,
      symbol,
      target
    })),
    [
      {
        ownerModule: owners[0],
        kind: "form_action",
        symbol: "createCalendarEventAction",
        target: "src/app/app/calendar/actions.ts#createCalendarEventAction"
      },
      ...[1, 2, 3].map((ordinal) => ({
        ownerModule: owners[1],
        kind: "global_fetch",
        symbol: `fetch[${ordinal}]`,
        target: "globalThis.fetch"
      })),
      {
        ownerModule: owners[1],
        kind: "form_action",
        symbol: "submit",
        target: `${owners[1]}#submit`
      },
      {
        ownerModule: owners[2],
        kind: "auth_client_call",
        symbol: "authClient.signUp.email[1]",
        target: "better-auth/react#createAuthClient.signUp.email"
      },
      {
        ownerModule: owners[2],
        kind: "auth_client_call",
        symbol: "authClient.signIn.email[1]",
        target: "better-auth/react#createAuthClient.signIn.email"
      },
      {
        ownerModule: owners[2],
        kind: "global_fetch",
        symbol: "fetch[1]",
        target: "globalThis.fetch"
      },
      {
        ownerModule: owners[2],
        kind: "form_action",
        symbol: "onSubmit",
        target: `${owners[2]}#onSubmit`
      },
      {
        ownerModule: owners[3],
        kind: "auth_client_call",
        symbol: "authClient.signOut[1]",
        target: "better-auth/react#createAuthClient.signOut"
      },
      ...[
        "authClient.listSessions[1]",
        "authClient.getSession[1]",
        "authClient.signOut[1]",
        "authClient.signOut[2]",
        "authClient.revokeSession[1]",
        "authClient.revokeOtherSessions[1]"
      ].map((symbol) => ({
        ownerModule: owners[4],
        kind: "auth_client_call",
        symbol,
        target: `better-auth/react#createAuthClient.${symbol.replace(/^authClient\.|\[\d+\]$/g, "")}`
      }))
    ]
  );

  const fixtureProgram = createProgramFromSources(repositoryRoot, {
    "src/app/client-action-fixture/actions.ts":
      '"use server"; export async function submitAction() {}',
    "src/lib/auth/client-fixture.ts":
      'import { createAuthClient } from "better-auth/react"; export const authClient = createAuthClient();',
    "src/components/client-binding-fixture.tsx":
      '"use client"; import { submitAction as submit } from "@/app/client-action-fixture/actions"; import { authClient } from "@/lib/auth/client-fixture"; export function Fixture() { fetch("/api/example"); submit(); return <form action={submit} />; }',
    "src/components/client-binding-unsupported.tsx":
      '"use client"; import { submitAction } from "@/app/client-action-fixture/actions"; import { authClient } from "@/lib/auth/client-fixture"; const request = fetch; request("/api/example"); authClient["signOut"](); wrap(submitAction)();'
  });
  const fixture = discoverClientBindings(fixtureProgram, repositoryRoot, [
    "src/components/client-binding-fixture.tsx",
    "src/components/client-binding-unsupported.tsx"
  ]);
  assert.deepEqual(
    fixture.observations
      .filter((entry) => entry.ownerModule.endsWith("client-binding-fixture.tsx"))
      .map(({ kind, symbol }) => ({ kind, symbol })),
    [
      { kind: "global_fetch", symbol: "fetch[1]" },
      { kind: "server_action", symbol: "submit[1]" },
      { kind: "form_action", symbol: "submit" }
    ]
  );
  assert.ok(
    fixture.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "unsupported_client_binding" &&
        diagnostic.file.endsWith("client-binding-unsupported.tsx")
    ).length >= 1
  );
});

test("discovers repository-wide fetch and renamed Better Auth bindings fail-closed", () => {
  const fixtureProgram = createProgramFromSources(repositoryRoot, {
    "src/lib/auth/renamed-client.ts":
      'import { createAuthClient as makeClient } from "better-auth/react"; export const sessionApi = makeClient();',
    "src/features/client-network.tsx":
      '"use client"; import { sessionApi as renamedClient } from "@/lib/auth/renamed-client"; const request = fetch; const { fetch: destructuredFetch } = globalThis; const directSignOut = renamedClient.signOut; const { revokeSession } = renamedClient; const { email: signInEmail } = renamedClient.signIn; export function ClientNetwork({ method }: { method: string }) { request("/api/alias"); globalThis.fetch("/api/global"); window.fetch("/api/window"); destructuredFetch("/api/destructured"); globalThis["fetch"]("/api/computed"); window[method]("/api/dynamic"); renamedClient.signOut(); directSignOut(); revokeSession(); signInEmail(); renamedClient["getSession"](); renamedClient[method](); wrap(renamedClient.signOut)(); return null; }'
  });
  const owner = "src/features/client-network.tsx";
  const fixture = discoverClientBindings(fixtureProgram, repositoryRoot, [owner]);
  assert.deepEqual(
    fixture.observations.map(({ kind, symbol, target }) => ({ kind, symbol, target })),
    [
      { kind: "global_fetch", symbol: "request[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "globalThis.fetch[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "window.fetch[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "destructuredFetch[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "globalThis.fetch[2]", target: "globalThis.fetch" },
      {
        kind: "auth_client_call",
        symbol: "renamedClient.signOut[1]",
        target: "better-auth/react#createAuthClient.signOut"
      },
      {
        kind: "auth_client_call",
        symbol: "directSignOut[1]",
        target: "better-auth/react#createAuthClient.signOut"
      },
      {
        kind: "auth_client_call",
        symbol: "revokeSession[1]",
        target: "better-auth/react#createAuthClient.revokeSession"
      },
      {
        kind: "auth_client_call",
        symbol: "signInEmail[1]",
        target: "better-auth/react#createAuthClient.signIn.email"
      },
      {
        kind: "auth_client_call",
        symbol: "renamedClient.getSession[1]",
        target: "better-auth/react#createAuthClient.getSession"
      }
    ]
  );
  assert.equal(
    fixture.diagnostics.filter(
      (diagnostic) => diagnostic.code === "unsupported_client_binding"
    ).length,
    3
  );

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-client-candidates-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", jsx: "preserve" }, include: ["src/**/*.ts", "src/**/*.tsx"] })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture(
      "src/features/client-owner.tsx",
      '"use client"; export function ClientOwner() { fetch("/api/example"); return null; }\n'
    );
    const registry = buildRepositoryRegistry(temporaryRoot);
    assert.ok(
      registry.owners.some(
        (entry) =>
          entry.ownerKind === "client_binding" &&
          entry.ownerModule === "src/features/client-owner.tsx"
      ),
      "client candidates must not be scoped to src/components"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("declares representative fetch and Better Auth client sidecars", () => {
  const required = new Set([
    "src/components/settings/registration-settings-form.operation.ts",
    "src/components/auth/auth-form.operation.ts",
    "src/components/sign-out-button.operation.ts",
    "src/components/settings/session-manager.operation.ts"
  ]);
  const registry = buildRepositoryRegistry(repositoryRoot, required);
  assert.deepEqual(registry.diagnostics, []);
  const declared = new Set(registry.declarations.map((entry) => entry.sidecarPath));
  for (const sidecar of required) assert.ok(declared.has(sidecar));
});

test("discovers instrumentation start and worker tick wiring without guessing", () => {
  const owners = [
    "src/instrumentation.ts",
    "src/server/automated-backup-scheduler.ts"
  ];
  const program = loadRepositoryProgram(repositoryRoot, owners);
  const actual = discoverWorkerWiring(program, repositoryRoot, owners);
  assert.deepEqual(actual.diagnostics, []);
  assert.deepEqual(
    actual.observations.map(({ ownerModule, kind, symbol, target }) => ({
      ownerModule,
      kind,
      symbol,
      target
    })),
    [
      {
        ownerModule: owners[0],
        kind: "worker_dynamic_import",
        symbol: "startAutomatedBackupScheduler",
        target: "src/server/automated-backup-scheduler.ts#startAutomatedBackupScheduler"
      },
      {
        ownerModule: owners[0],
        kind: "worker_dynamic_import",
        symbol: "startIntegrityScheduler",
        target: "src/server/integrity-scheduler.ts#startIntegrityScheduler"
      },
      {
        ownerModule: owners[0],
        kind: "worker_dynamic_import",
        symbol: "startSproutSourceRetentionScheduler",
        target: "src/server/sprout-source-retention-scheduler.ts#startSproutSourceRetentionScheduler"
      },
      ...[
        ["startAutomatedBackupScheduler", "automated-backup-scheduler"],
        ["startIntegrityScheduler", "integrity-scheduler"],
        ["startSproutSourceRetentionScheduler", "sprout-source-retention-scheduler"]
      ].map(([symbol, module]) => ({
        ownerModule: owners[0],
        kind: "worker_start_call",
        symbol,
        target: `src/server/${module}.ts#${symbol}`
      })),
      {
        ownerModule: owners[1],
        kind: "worker_start_call",
        symbol: "startAutomatedBackupScheduler",
        target: `${owners[1]}#startAutomatedBackupScheduler`
      },
      {
        ownerModule: owners[1],
        kind: "worker_tick",
        symbol: "tick",
        target: "src/server/services/automated-backups.ts#runAutomatedBackupScan"
      },
      {
        ownerModule: owners[1],
        kind: "worker_schedule",
        symbol: "tick",
        target: `${owners[1]}#tick`
      }
    ]
  );

  const fixtureProgram = createProgramFromSources(repositoryRoot, {
    "src/server/worker-fixture.ts": "export function startWorker() {}",
    "src/instrumentation-alias-fixture.ts":
      'export async function register() { const [{ startWorker: boot }] = await Promise.all([import("@/server/worker-fixture")]); boot(); }',
    "src/instrumentation-namespace-fixture.ts":
      'export async function register() { const worker = await import("@/server/worker-fixture"); worker.startWorker(); }',
    "src/instrumentation-wrapper-fixture.ts":
      'export async function register() { const [{ startWorker: boot }] = await Promise.all([import("@/server/worker-fixture")]); invoke(boot); }',
    "src/instrumentation-indirect-fixture.ts":
      'export async function register() { const [{ startWorker: boot }] = await Promise.all([import("@/server/worker-fixture")]); const indirect = boot; indirect(); }'
  });
  const fixture = discoverWorkerWiring(fixtureProgram, repositoryRoot, [
    "src/instrumentation-alias-fixture.ts",
    "src/instrumentation-namespace-fixture.ts",
    "src/instrumentation-wrapper-fixture.ts",
    "src/instrumentation-indirect-fixture.ts"
  ]);
  assert.deepEqual(
    fixture.observations
      .filter((entry) => entry.ownerModule.endsWith("alias-fixture.ts"))
      .map(({ kind, symbol, target }) => ({ kind, symbol, target })),
    [
      {
        kind: "worker_dynamic_import",
        symbol: "boot",
        target: "src/server/worker-fixture.ts#startWorker"
      },
      {
        kind: "worker_start_call",
        symbol: "boot",
        target: "src/server/worker-fixture.ts#startWorker"
      }
    ]
  );
  for (const suffix of ["namespace-fixture.ts", "wrapper-fixture.ts", "indirect-fixture.ts"]) {
    assert.ok(
      fixture.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_worker_wiring" &&
          diagnostic.file.endsWith(suffix)
      )
    );
  }
});

test("declares representative instrumentation and backup-worker sidecars", () => {
  const required = new Set([
    "src/instrumentation.operation.ts",
    "src/server/automated-backup-scheduler.operation.ts"
  ]);
  const registry = buildRepositoryRegistry(repositoryRoot, required);
  assert.deepEqual(registry.diagnostics, []);
  const declared = new Set(registry.declarations.map((entry) => entry.sidecarPath));
  for (const sidecar of required) assert.ok(declared.has(sidecar));
});

test("discovers TypeScript package owners and exact CLI command variants", () => {
  const packageOwners = [
    "scripts/activity-update-safety-rehearsal.ts",
    "scripts/backup-recovery-rehearsal.ts",
    "scripts/integrity-check.ts",
    "scripts/platform-owner.ts",
    "scripts/sprout-preview-commit.acceptance-rehearsal.ts",
    "scripts/update-preflight.ts",
    "prisma/seed.ts"
  ];
  const program = loadRepositoryProgram(repositoryRoot, packageOwners);
  const actual = discoverPackageCommands(program, repositoryRoot);
  assert.deepEqual(actual.diagnostics, []);
  assert.deepEqual(
    [...new Set(actual.observations.map((entry) => entry.ownerModule))].sort(),
    [...packageOwners].sort()
  );
  assert.deepEqual(
    actual.observations
      .filter((entry) => entry.ownerModule === "scripts/platform-owner.ts")
      .map(({ kind, symbol, target }) => ({ kind, symbol, target })),
    [
      {
        kind: "package_script",
        symbol: "build:platform-owner",
        target: "package.json#scripts.build:platform-owner"
      },
      {
        kind: "package_script",
        symbol: "platform:owner",
        target: "package.json#scripts.platform:owner"
      },
      ...[
        "verify-bootstrap",
        "attest-successor",
        "bind",
        "recover",
        "inspect-backup-recovery",
        "provision-backup-recovery-target",
        "authorize-backup-recovery"
      ].map((variant) => ({
        kind: "command_variant",
        symbol: variant,
        target: `scripts/platform-owner.ts#parsePlatformOwnerCommand:${variant}`
      }))
    ]
  );

  const fixtureProgram = createProgramFromSources(repositoryRoot, {
    "scripts/command-fixture.ts":
      'export function parseToolCommand(args: string[]) { const [operation] = args; if (operation === "inspect") return operation; switch (operation) { case "repair": return operation; default: throw new Error("usage"); } } void parseToolCommand(process.argv.slice(2));'
  });
  const fixture = discoverPackageCommands(
    fixtureProgram,
    repositoryRoot,
    JSON.stringify({
      scripts: {
        tool: "tsx scripts/command-fixture.ts",
        renamed: "tsx ./scripts/command-fixture.ts",
        missing: "tsx scripts/missing-command.ts"
      }
    })
  );
  assert.deepEqual(
    fixture.observations.map(({ kind, symbol }) => ({ kind, symbol })),
    [
      { kind: "package_script", symbol: "tool" },
      { kind: "package_script", symbol: "renamed" },
      { kind: "command_variant", symbol: "inspect" },
      { kind: "command_variant", symbol: "repair" }
    ]
  );
  assert.ok(
    fixture.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unresolved_package_command" &&
        diagnostic.detail.includes("scripts/missing-command.ts")
    )
  );
});

test("parses quoted multiple arbitrary TypeScript package paths and renamed command discriminants", () => {
  const fixtureProgram = createProgramFromSources(repositoryRoot, {
    "tools/alpha.ts":
      'export function parseToolCommand(args: string[]) { const [command] = args; if (command === "inspect") return { kind: "inspect" }; switch (command) { case "repair": return { kind: "repair" }; default: throw new Error("usage"); } } void parseToolCommand(process.argv.slice(2));',
    "tools/beta.ts": "export const beta = true;",
    "tools/gamma.ts": "export const gamma = true;",
    "tools/unsupported.ts":
      'export function parseUnsupportedCommand(args: string[]) { const [verb] = args; const aliases: Record<string, string> = {}; return { kind: aliases[verb] }; } void parseUnsupportedCommand(process.argv.slice(2));'
  });
  const packageJsonText = JSON.stringify({
    scripts: {
      multi: 'tsx "tools/alpha.ts" && tsx \'tools/beta.ts\'',
      quoted: 'tsx "./tools/gamma.ts"',
      unsupported: "tsx tools/unsupported.ts",
      missing: "tsx tools/missing.ts"
    }
  });
  const fixture = discoverPackageCommands(
    fixtureProgram,
    repositoryRoot,
    packageJsonText
  );
  assert.deepEqual(
    [...new Set(fixture.observations.map((entry) => entry.ownerModule))].sort(),
    ["tools/alpha.ts", "tools/beta.ts", "tools/gamma.ts", "tools/unsupported.ts"]
  );
  assert.deepEqual(
    fixture.observations
      .filter((entry) => entry.kind === "command_variant")
      .map(({ ownerModule, symbol, target }) => ({ ownerModule, symbol, target })),
    [
      {
        ownerModule: "tools/alpha.ts",
        symbol: "inspect",
        target: "tools/alpha.ts#parseToolCommand:inspect"
      },
      {
        ownerModule: "tools/alpha.ts",
        symbol: "repair",
        target: "tools/alpha.ts#parseToolCommand:repair"
      }
    ]
  );
  assert.ok(
    fixture.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unsupported_package_command_variant" &&
        diagnostic.file === "tools/unsupported.ts"
    )
  );
  assert.ok(
    fixture.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unresolved_package_command" &&
        diagnostic.detail.includes("tools/missing.ts")
    )
  );

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-package-candidates-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext" }, include: ["tools/**/*.ts"] })
    );
    writeFixture("package.json", JSON.stringify({ scripts: { tool: 'tsx "tools/alpha.ts"' } }));
    writeFixture("tools/alpha.ts", "export const alpha = true;\n");
    const registry = buildRepositoryRegistry(temporaryRoot);
    assert.ok(
      registry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "observation_set_mismatch" &&
          diagnostic.file === "tools/alpha.operation.ts" &&
          diagnostic.detail === "discovered_owner_not_in_appendix"
      ),
      "a new arbitrary TypeScript package owner must reach the Appendix mismatch"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("binds packaged command entrypoints through package build and Docker COPY anchors", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-container-bindings-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext" }, include: ["scripts/**/*.ts"] })
    );
    writeFixture("scripts/platform-owner.ts", "export const platformOwner = true;\n");
    writeFixture("scripts/integrity-check.ts", "export const integrity = true;\n");
    writeFixture(
      "package.json",
      JSON.stringify({
        scripts: {
          build: "npm run build:platform-owner && npm run build:integrity",
          "build:platform-owner":
            "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs",
          "build:integrity":
            "esbuild scripts/integrity-check.ts --bundle --outfile=dist/integrity-check.mjs"
        }
      })
    );
    writeFixture(
      "Dockerfile",
      [
        "FROM node:22 AS builder",
        "WORKDIR /app",
        "FROM node:22 AS runner",
        "WORKDIR /app",
        "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
        "COPY --from=builder /app/dist/integrity-check.mjs ./integrity-check.mjs"
      ].join("\n") + "\n"
    );

    const registry = buildRepositoryRegistry(temporaryRoot);
    for (const [ownerModule, output] of [
      ["scripts/platform-owner.ts", "platform-owner.mjs"],
      ["scripts/integrity-check.ts", "integrity-check.mjs"]
    ]) {
      const owner = registry.owners.find((entry) => entry.ownerModule === ownerModule);
      assert.deepEqual(
        owner?.bindings.map(({ kind, symbol, target }) => ({ kind, symbol, target })),
        [
          {
            kind: "container_copy",
            symbol: output,
            target: `Dockerfile#/app/dist/${output}=>/app/${output}`
          },
          {
            kind: "package_build_entrypoint",
            symbol: ownerModule,
            target: `${ownerModule}=>dist/${output}`
          },
          {
            kind: "package_build_invocation",
            symbol: "build",
            target: `package.json#scripts.build:${ownerModule === "scripts/platform-owner.ts" ? "build:platform-owner" : "build:integrity"}`
          },
          {
            kind: "package_script",
            symbol: ownerModule === "scripts/platform-owner.ts" ? "build:platform-owner" : "build:integrity",
            target: `package.json#scripts.${ownerModule === "scripts/platform-owner.ts" ? "build:platform-owner" : "build:integrity"}`
          }
        ]
      );
    }
    assert.deepEqual(
      registry.diagnostics.filter(
        (diagnostic) => diagnostic.code === "unsupported_container_command"
      ),
      []
    );

    writeFixture(
      "Dockerfile",
      readFileSync(resolve(temporaryRoot, "Dockerfile"), "utf8") +
        "COPY --from=builder /app/dist/rogue.mjs ./rogue.mjs\n"
    );
    const unmatched = buildRepositoryRegistry(temporaryRoot);
    assert.ok(
      unmatched.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_container_command" &&
          diagnostic.detail === "container_bundle_build_missing:dist/rogue.mjs"
      )
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("binds static container entrypoint invocations and rejects unmatched operational bundles", () => {
  const packageJsonText = JSON.stringify({
    scripts: {
      build: "npm run build:platform-owner",
      "build:platform-owner":
        "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs"
    }
  });
  const dockerfileText = [
    "FROM node:22 AS builder",
    "WORKDIR /app",
    "FROM node:22 AS runner",
    "WORKDIR /app",
    "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs"
  ].join("\n") + "\n";
  const entrypointText = [
    "#!/bin/sh",
    'if [ "${1:-}" = "platform-owner" ]; then',
    '  node /app/platform-owner.mjs "${2:-}"',
    "fi",
    'if [ "${RUN_ROGUE_OPERATOR:-}" = "1" ]; then',
    '  node "/app/rogue-operator.mjs" "$@"',
    "fi",
    'node "/app/${OPERATION_NAME}.mjs" "$@"',
    'node "$OPERATION_BUNDLE" "$@"',
    "exec node server.js"
  ].join("\n") + "\n";

  const discovery = discoverContainerCommandBindings(
    repositoryRoot,
    packageJsonText,
    dockerfileText,
    entrypointText
  );

  assert.deepEqual(
    discovery.observations
      .filter((entry) => entry.kind === "container_invocation")
      .map(({ ownerModule, symbol, target, anchorFile }) => ({
        ownerModule,
        symbol,
        target,
        anchorFile
      })),
    [
      {
        ownerModule: "scripts/platform-owner.ts",
        symbol: "platform-owner.mjs",
        target: "docker/entrypoint.sh#/app/platform-owner.mjs",
        anchorFile: "docker/entrypoint.sh"
      }
    ]
  );
  assert.deepEqual(
    discovery.diagnostics.map(({ code, file, detail }) => ({ code, file, detail })),
    [
      {
        code: "unsupported_container_command",
        file: "docker/entrypoint.sh",
        detail: "container_invocation_copy_missing:/app/rogue-operator.mjs"
      },
      {
        code: "unsupported_container_command",
        file: "docker/entrypoint.sh",
        detail: "unsupported_computed_operational_mjs_invocation"
      },
      {
        code: "unsupported_container_command",
        file: "docker/entrypoint.sh",
        detail: "unsupported_dynamic_node_invocation"
      }
    ]
  );

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-entrypoint-fingerprint-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext" },
        include: ["scripts/**/*.ts"]
      })
    );
    writeFixture("package.json", packageJsonText);
    writeFixture(
      "Dockerfile",
      dockerfileText +
        "COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/cubby-entrypoint\n" +
        'ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]\n'
    );
    writeFixture(
      "docker/entrypoint.sh",
      "#!/bin/sh\nnode \"/app/platform-owner.mjs\" bind\n"
    );
    writeFixture("scripts/platform-owner.ts", "export const platformOwner = true;\n");
    writeFixture(
      "src/server/operation-registry/schema.ts",
      readFileSync(resolve(repositoryRoot, "src/server/operation-registry/schema.ts"), "utf8")
    );
    writeFixture(
      "src/server/operation-registry/checker.ts",
      readFileSync(resolve(repositoryRoot, "src/server/operation-registry/checker.ts"), "utf8")
    );
    writeFixture(
      "scripts/operation-registry.ts",
      readFileSync(resolve(repositoryRoot, "scripts/operation-registry.ts"), "utf8")
    );

    const artifacts = buildRepositoryArtifacts(temporaryRoot);
    const fingerprints = JSON.parse(
      artifacts.artifacts["src/server/operation-registry/generated/fingerprints.json"]
    );
    const ownerFingerprint = fingerprints.fingerprints.find(
      (entry) => entry.ownerModule === "scripts/platform-owner.ts"
    );
    assert.deepEqual(
      ownerFingerprint?.anchorFiles.map((entry) => entry.file).sort(),
      [
        "Dockerfile",
        "docker/entrypoint.sh",
        "package.json",
        "scripts/platform-owner.ts"
      ]
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("declares the representative platform-owner command sidecar", () => {
  const required = new Set(["scripts/platform-owner.operation.ts"]);
  const registry = buildRepositoryRegistry(repositoryRoot, required);
  assert.deepEqual(registry.diagnostics, []);
  assert.ok(
    registry.declarations.some((entry) => required.has(entry.sidecarPath))
  );
});

test("shares esbuild output operand ranges without hiding source inputs", () => {
  const outputOptions = ["--outfile", "--outdir", "--output", "--output-file", "-o"];
  const scripts = {
    ...Object.fromEntries(
      outputOptions.flatMap((option, index) => [
        [
          `split-${index}`,
          `esbuild scripts/source.ts --bundle ${option} dist/missing-rehearsal-${index}.ts`
        ],
        [
          `equals-${index}`,
          `./node_modules/.bin/esbuild scripts/source.ts --bundle ${option}=dist/missing-equals-rehearsal-${index}.ts`
        ]
      ])
    ),
    "dynamic-output": 'esbuild scripts/source.ts --outfile "$OUTPUT.mjs"',
    "missing-outdir": "tsx --outdir scripts/missing-rehearsal.ts",
    "missing-output": "tsx --output scripts/missing-rehearsal.ts"
  };
  const program = createProgramFromSources(repositoryRoot, {
    "scripts/source.ts": "export const source = true;\n"
  });
  const packageResult = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({ scripts })
  );

  assert.deepEqual(
    packageResult.observations
      .filter(({ kind }) => kind === "package_script")
      .map(({ ownerModule, symbol }) => ({ ownerModule, symbol })),
    Object.keys(scripts)
      .filter((symbol) => !symbol.startsWith("missing-"))
      .map((symbol) => ({ ownerModule: "scripts/source.ts", symbol }))
  );
  assert.deepEqual(packageResult.diagnostics, [
    {
      code: "unresolved_package_command",
      file: "package.json",
      detail: "typescript_command_owner_missing:scripts/missing-rehearsal.ts"
    },
    {
      code: "unresolved_package_command",
      file: "package.json",
      detail: "typescript_command_owner_missing:scripts/missing-rehearsal.ts"
    }
  ]);
  const exclusionResult = discoverStructuralExclusions(
    repositoryRoot,
    JSON.stringify({ scripts }),
    new Set(["scripts/source.ts"])
  );
  assert.deepEqual(exclusionResult.diagnostics, [
    {
      code: "stale_structural_exclusion",
      file: "package.json",
      detail: "excluded_owner_missing:scripts/missing-rehearsal.ts"
    },
    {
      code: "stale_structural_exclusion",
      file: "package.json",
      detail: "excluded_owner_missing:scripts/missing-rehearsal.ts"
    }
  ]);
});

test("does not require current package esbuild outputs to exist", () => {
  const currentPathsWithoutBuildOutputs = {
    has: (ownerModule) =>
      !ownerModule.startsWith("dist/") &&
      existsSync(resolve(repositoryRoot, ownerModule))
  };
  const result = discoverStructuralExclusions(
    repositoryRoot,
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
    currentPathsWithoutBuildOutputs
  );
  assert.deepEqual(result.diagnostics, []);
});

test("classifies rehearsal, fixture, build-tool, and registry exclusions exactly", () => {
  const actual = discoverStructuralExclusions(repositoryRoot);
  assert.deepEqual(actual.diagnostics, []);
  assert.deepEqual(
    actual.exclusions.map(({ ownerModule, category, packageScripts }) => ({
      ownerModule,
      category,
      packageScripts
    })),
    [
      {
        ownerModule: "scripts/operation-registry.ts",
        category: "registry_tooling",
        packageScripts: ["operation-registry:generate", "operation-registry:check"]
      },
      {
        ownerModule: "scripts/backup-recovery-rehearsal.ts",
        category: "rehearsal",
        packageScripts: ["verify:backup-recovery", "verify:update-rehearsal"]
      },
      {
        ownerModule: "scripts/activity-update-safety-rehearsal.ts",
        category: "rehearsal",
        packageScripts: ["verify:activity-update-safety"]
      },
      {
        ownerModule: "scripts/sprout-preview-commit.acceptance-rehearsal.ts",
        category: "rehearsal",
        packageScripts: ["verify:sprout-preview-commit"]
      },
      {
        ownerModule: "scripts/generate-brand-icons.mjs",
        category: "build_tool",
        packageScripts: ["brand:icons"]
      },
      {
        ownerModule: "prisma/seed.ts",
        category: "fixture",
        packageScripts: ["db:seed"]
      }
    ]
  );

  const fixture = discoverStructuralExclusions(
    repositoryRoot,
    JSON.stringify({
      scripts: {
        rehearsal: "tsx scripts/example-rehearsal.ts",
        registry: "node scripts/operation-registry.ts --check",
        icons: "node scripts/missing-icons.mjs"
      }
    }),
    new Set(["scripts/example-rehearsal.ts", "scripts/operation-registry.ts"])
  );
  assert.deepEqual(
    fixture.exclusions.map(({ ownerModule, category }) => ({ ownerModule, category })),
    [
      { ownerModule: "scripts/example-rehearsal.ts", category: "rehearsal" },
      { ownerModule: "scripts/operation-registry.ts", category: "registry_tooling" }
    ]
  );
  assert.ok(
    fixture.diagnostics.some(
      (diagnostic) => diagnostic.code === "stale_structural_exclusion"
    )
  );
});

test("declares one representative rehearsal as a structural exclusion", () => {
  const required = new Set([
    "scripts/activity-update-safety-rehearsal.operation.ts"
  ]);
  const registry = buildRepositoryRegistry(repositoryRoot, required);
  assert.deepEqual(registry.diagnostics, []);
  const entry = registry.declarations.find((candidate) =>
    required.has(candidate.sidecarPath)
  );
  assert.equal(entry?.declaration.disposition, "excluded");
  assert.equal(entry?.declaration.exclusion?.category, "rehearsal");
});

test("rejects generated drift and tamper without writing", () => {
  const input = {
    observationRegistry: {
      schemaVersion: 1,
      owners: [{ id: "owner:a", sidecarPath: "sidecars/a.operation.ts" }],
      declarations: [{ id: "owner:a", sidecarPath: "sidecars/a.operation.ts" }]
    },
    fingerprints: { schemaVersion: 1, entries: [{ id: "owner:a", digest: "abc" }] },
    deferredGates: { schemaVersion: 1, gates: [], evidence: [] }
  };
  const reordered = {
    deferredGates: { evidence: [], gates: [], schemaVersion: 1 },
    fingerprints: { entries: [{ digest: "abc", id: "owner:a" }], schemaVersion: 1 },
    observationRegistry: {
      declarations: [{ sidecarPath: "sidecars/a.operation.ts", id: "owner:a" }],
      owners: [{ sidecarPath: "sidecars/a.operation.ts", id: "owner:a" }],
      schemaVersion: 1
    }
  };
  const expected = renderGeneratedArtifacts(input);
  assert.deepEqual(expected, renderGeneratedArtifacts(reordered));

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-operation-registry-"));
  try {
    for (const [file, content] of Object.entries(expected)) {
      const target = resolve(temporaryRoot, file);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    const observationPath = resolve(
      temporaryRoot,
      "src/server/operation-registry/generated/observation-registry.json"
    );
    const tampered = JSON.parse(readFileSync(observationPath, "utf8"));
    tampered.owners.push(tampered.owners[0], {
      id: "owner:stale",
      sidecarPath: "sidecars/stale.operation.ts"
    });
    writeFileSync(observationPath, `${JSON.stringify(tampered, null, 2)}\n`);
    unlinkSync(
      resolve(temporaryRoot, "src/server/operation-registry/generated/fingerprints.json")
    );
    const before = snapshotTree(temporaryRoot);
    const diagnostics = checkGeneratedArtifacts(temporaryRoot, expected, new Set());
    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    assert.ok(codes.includes("generated_artifact_mismatch"));
    assert.ok(codes.includes("missing_generated_artifact"));
    assert.ok(codes.includes("duplicate_generated_id"));
    assert.ok(codes.includes("stale_generated_row"));
    assert.ok(codes.includes("missing_sidecar"));
    assert.deepEqual(snapshotTree(temporaryRoot), before);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("invalidates fingerprints for owner, sidecar, target, and anchor drift", () => {
  const input = {
    id: "api-route:test",
    ownerModule: "src/app/api/test/route.ts",
    ownerBytes: "export function GET() { return ok(); }",
    sidecarPath: "src/app/api/test/route.operation.ts",
    sidecarBytes: "export const operation = literal;",
    bindings: [
      {
        kind: "route_method",
        symbol: "GET",
        target: "src/app/api/test/route.ts#GET",
        anchorStart: 0,
        anchorEnd: 38
      }
    ],
    schemaDigest: "schema-v1",
    generatorDigest: "generator-v1"
  };
  const baseline = computeStructuralFingerprint(input);
  assert.deepEqual(baseline.diagnostics, []);
  assert.ok(baseline.digest);

  for (const mutation of [
    { ...input, ownerBytes: input.ownerBytes.replace("ok", "changed") },
    { ...input, sidecarBytes: `${input.sidecarBytes}\n` },
    {
      ...input,
      bindings: [
        { ...input.bindings[0], target: "src/app/api/canonical/route.ts#GET" }
      ]
    }
  ]) {
    assert.ok(
      validateStructuralFingerprint(baseline.digest, mutation).some(
        (diagnostic) => diagnostic.code === "fingerprint_mismatch"
      )
    );
  }

  const unresolved = computeStructuralFingerprint({
    ...input,
    bindings: [{ ...input.bindings[0], anchorStart: -1, anchorEnd: -1 }]
  });
  assert.equal(unresolved.digest, null);
  assert.ok(
    unresolved.diagnostics.some(
      (diagnostic) => diagnostic.code === "unresolved_fingerprint_anchor"
    )
  );
});

test("versions owner identity and hashes the full normalized observation anchors", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-observation-digest-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext" }, include: ["src/**/*.ts"] })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture("src/app/route.ts", "export function GET() { return new Response('one'); }\n");
    writeFixture(
      "src/server/operation-registry/schema.ts",
      readFileSync(resolve(repositoryRoot, "src/server/operation-registry/schema.ts"), "utf8")
    );
    writeFixture(
      "src/server/operation-registry/checker.ts",
      readFileSync(resolve(repositoryRoot, "src/server/operation-registry/checker.ts"), "utf8")
    );
    writeFixture(
      "scripts/operation-registry.ts",
      readFileSync(resolve(repositoryRoot, "scripts/operation-registry.ts"), "utf8")
    );
    const baseline = buildRepositoryArtifacts(temporaryRoot);
    writeFixture("src/app/route.ts", "export function GET() { return new Response('two'); }\n");
    const drifted = buildRepositoryArtifacts(temporaryRoot);
    assert.notEqual(
      baseline.observationDigest,
      drifted.observationDigest,
      "binding anchor byte drift must change the full observation digest"
    );
    assert.equal(
      baseline.ownerSetDigest,
      drifted.ownerSetDigest,
      "owner identity digest must remain stable for binding-only drift"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const built = buildRepositoryArtifacts(repositoryRoot);
  const observation = JSON.parse(
    built.artifacts["src/server/operation-registry/generated/observation-registry.json"]
  );
  const fingerprints = JSON.parse(
    built.artifacts["src/server/operation-registry/generated/fingerprints.json"]
  );
  assert.equal(observation.ownerSetDigestVersion, "owner-set.v1");
  assert.equal(observation.observationDigestVersion, "normalized-observation.v1");
  assert.equal(observation.ownerSetDigest, built.ownerSetDigest);
  assert.equal(observation.ownerSetCanonical.length, observation.owners.length);
  assert.equal(observation.observationCanonical.length, observation.owners.length);
  for (const owner of observation.observationCanonical) {
    for (const binding of owner.bindings) {
      assert.equal(typeof binding.anchorFile, "string");
      assert.match(binding.anchorDigest, /^[a-f0-9]{64}$/);
    }
  }
  assert.deepEqual(
    observation.structuralIdentityAnchors.map(
      ({ kind, file, targetFile }) => ({ kind, file, targetFile })
    ),
    [
      {
        kind: "container_build_selector",
        file: "docker-compose.yml",
        targetFile: "Dockerfile"
      },
      {
        kind: "container_build_selector",
        file: "scripts/backup-recovery-rehearsal.compose.yml",
        targetFile: "Dockerfile"
      },
      {
        kind: "container_dockerfile",
        file: "Dockerfile",
        targetFile: "Dockerfile"
      }
    ]
  );
  assert.ok(
    observation.structuralIdentityAnchors.every(({ anchorDigest }) =>
      /^[a-f0-9]{64}$/.test(anchorDigest)
    ),
    "every Compose selector and selected Dockerfile byte range must enter aggregate identity"
  );
  const platformFingerprint = fingerprints.fingerprints.find(
    (entry) => entry.ownerModule === "scripts/platform-owner.ts"
  );
  assert.deepEqual(
    platformFingerprint.anchorFiles.map((entry) => entry.file).sort(),
    [
      "Dockerfile",
      "docker-compose.yml",
      "package.json",
      "scripts/backup-recovery-rehearsal.compose.yml",
      "scripts/platform-owner.ts"
    ]
  );
});

test("rejects invalid gates, evidence, outcomes, and deferred promotion", () => {
  const expectedGateIds = [
    "gate.carrier_authority_guard",
    "gate.caller_controlled_scope",
    "gate.service_operation_linkage",
    "gate.permission_commit_reauthorization",
    "gate.tenant_relationship_invariants",
    "gate.model_and_effects",
    "gate.variant_outcomes",
    "gate.worker_containment",
    "gate.browser_binding_staleness",
    "gate.executable_evidence"
  ];
  const baseline = buildDeferredGateRegistry();
  assert.equal(baseline.authority, "observation_only");
  assert.deepEqual(
    baseline.gates.map((gate) => gate.id),
    expectedGateIds
  );
  assert.deepEqual(baseline.evidence, []);
  assert.deepEqual(
    validateGateEvidenceIntegrity(baseline, new Set(["fingerprint:a"])),
    []
  );

  const expectCode = (registry, code, declarations = []) => {
    assert.ok(
      validateGateEvidenceIntegrity(
        registry,
        new Set(["fingerprint:a"]),
        declarations
      ).some((diagnostic) => diagnostic.code === code),
      `expected ${code}`
    );
  };
  expectCode(
    { ...baseline, gates: baseline.gates.slice(1) },
    "missing_gate"
  );
  expectCode(
    { ...baseline, gates: [...baseline.gates, baseline.gates[0]] },
    "duplicate_gate"
  );
  expectCode(
    {
      ...baseline,
      gates: [...baseline.gates, { ...baseline.gates[0], id: "gate.invented" }]
    },
    "orphan_gate"
  );
  expectCode(
    {
      ...baseline,
      gates: [{ ...baseline.gates[0], status: "source_reviewed" }, ...baseline.gates.slice(1)]
    },
    "deferred_gate_promotion"
  );

  const evidence = {
    id: "evidence.invented",
    gateId: expectedGateIds[0],
    status: "passed",
    strength: "hostile_tested",
    fingerprintId: "fingerprint:a",
    outcomes: [{ variant: "GET", result: "passed" }]
  };
  expectCode({ ...baseline, evidence: [evidence] }, "invented_evidence");
  expectCode(
    { ...baseline, evidence: [{ ...evidence, gateId: "gate.invented" }] },
    "orphan_evidence_gate"
  );
  for (const status of ["skip", "todo"]) {
    expectCode(
      { ...baseline, evidence: [{ ...evidence, status }] },
      "unsupported_evidence_status"
    );
  }
  expectCode(
    { ...baseline, evidence: [{ ...evidence, strength: "mock_tested" }] },
    "unsupported_evidence_strength"
  );
  expectCode(
    { ...baseline, evidence: [{ ...evidence, fingerprintId: "fingerprint:wrong" }] },
    "orphan_evidence_fingerprint"
  );
  expectCode(
    { ...baseline, evidence: [{ ...evidence, outcomes: [] }] },
    "collapsed_evidence_outcome"
  );

  const declaration = {
    schemaVersion: 1,
    id: "test",
    ownerModule: "src/example.ts",
    ownerKind: "server_action",
    bindings: [],
    disposition: "observed",
    deferredGateIds: ["gate.invented"]
  };
  expectCode(baseline, "missing_deferred_gate_reference", [declaration]);
  expectCode(baseline, "orphan_deferred_gate_reference", [declaration]);
});

test("closes declaration dispositions and every deferred gate field", () => {
  const observedWithExclusion = `{
    ${validBody.slice(1, -1)},
    exclusion: { category: "fixture", rationale: "impossible" }
  }`;
  const excludedWithoutExclusion = validBody
    .replace('disposition: "observed"', 'disposition: "excluded"');
  for (const [name, body] of [
    ["observed-exclusion", observedWithExclusion],
    ["excluded-without-exclusion", excludedWithoutExclusion]
  ]) {
    const parsed = parseSidecarSource(
      `${name}.operation.ts`,
      `import type { OperationDeclaration } from "@/server/operation-registry/schema"; export const operation = ${body} as const satisfies OperationDeclaration;`
    );
    assert.ok(
      parsed.diagnostics.some(
        (diagnostic) => diagnostic.code === "invalid_sidecar_schema"
      ),
      `${name} must be rejected at runtime`
    );
  }

  const typeFixtureRoot = resolve(repositoryRoot, "src/server/operation-registry-type-fixture");
  const typeProgram = createProgramFromSources(typeFixtureRoot, {
    "schema.ts": readFileSync(resolve(repositoryRoot, "src/server/operation-registry/schema.ts"), "utf8"),
    "bad-observed.ts":
      'import type { OperationDeclaration } from "./schema"; export const operation = { schemaVersion: 1, id: "a", ownerModule: "a.ts", ownerKind: "server_action", bindings: [], disposition: "observed", exclusion: { category: "fixture", rationale: "impossible" }, deferredGateIds: [] } as const satisfies OperationDeclaration;',
    "bad-excluded.ts":
      'import type { OperationDeclaration } from "./schema"; export const operation = { schemaVersion: 1, id: "b", ownerModule: "b.ts", ownerKind: "server_action", bindings: [], disposition: "excluded", deferredGateIds: [] } as const satisfies OperationDeclaration;'
  });
  assert.equal(
    typeProgram.getSemanticDiagnostics().filter(
      (diagnostic) => diagnostic.file?.fileName.endsWith("bad-observed.ts") || diagnostic.file?.fileName.endsWith("bad-excluded.ts")
    ).length,
    2,
    "the TypeScript declaration must be a closed discriminated union"
  );

  const baseline = buildDeferredGateRegistry();
  const expectCode = (registry, code, declarations = []) => {
    assert.ok(
      validateGateEvidenceIntegrity(registry, new Set(), declarations).some(
        (diagnostic) => diagnostic.code === code
      ),
      `expected ${code}`
    );
  };
  expectCode(
    { ...baseline, unknown: true },
    "invalid_gate_registry_shape"
  );
  for (const malformed of [
    { ...baseline.gates[0], unknown: true },
    { ...baseline.gates[0], rationale: "altered" },
    { ...baseline.gates[0], dependencyPhase: "R9" },
    { ...baseline.gates[0], blockedAxes: ["wrong_axis"] },
    "not-an-object"
  ]) {
    expectCode(
      { ...baseline, gates: [malformed, ...baseline.gates.slice(1)] },
      "invalid_gate_shape"
    );
  }
  const duplicateGateDeclaration = {
    schemaVersion: 1,
    id: "duplicate-gate-test",
    ownerModule: "src/example.ts",
    ownerKind: "server_action",
    bindings: [],
    disposition: "observed",
    deferredGateIds: [
      ...baseline.gates.map((gate) => gate.id),
      baseline.gates[0].id
    ]
  };
  expectCode(
    baseline,
    "duplicate_deferred_gate_reference",
    [duplicateGateDeclaration]
  );
});

test("discovers transitive client value-import helpers without crossing RPC or type boundaries", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-client-closure-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          baseUrl: ".",
          paths: { "@/*": ["src/*"] }
        },
        include: ["src/**/*.ts", "src/**/*.tsx"]
      })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture(
      "src/lib/auth-client.ts",
      'import { createAuthClient } from "better-auth/react"; export const authClient = createAuthClient();\n'
    );
    writeFixture(
      "src/actions.ts",
      '"use server"; export async function saveAction() { fetch("https://server.invalid"); }\n'
    );
    writeFixture(
      "src/helpers/nested.ts",
      'export function nestedRequest() { return globalThis.fetch("/api/nested"); }\n'
    );
    writeFixture(
      "src/helpers/request.ts",
      'import { nestedRequest } from "./nested"; export function request() { fetch("/api/helper"); return nestedRequest(); }\n'
    );
    writeFixture(
      "src/helpers/session.ts",
      'import { authClient } from "@/lib/auth-client"; export function signOut() { return authClient.signOut(); }\n'
    );
    writeFixture(
      "src/helpers/action.ts",
      'import { saveAction } from "@/actions"; export function save() { return saveAction(); }\n'
    );
    writeFixture(
      "src/helpers/type-only.ts",
      'export type Ignored = string; export function hiddenRequest() { return window.fetch("/api/type-only"); }\n'
    );
    writeFixture(
      "src/client.tsx",
      '"use client"; import { request } from "@/helpers/request"; import { signOut } from "@/helpers/session"; import { save } from "@/helpers/action"; import { saveAction } from "@/actions"; import type { Ignored } from "@/helpers/type-only"; export function Client(_: { value?: Ignored }) { request(); signOut(); save(); saveAction(); return null; }\n'
    );

    const registry = buildRepositoryRegistry(temporaryRoot);
    const clients = registry.owners
      .filter((owner) => owner.ownerKind === "client_binding")
      .map((owner) => owner.ownerModule)
      .sort();
    assert.deepEqual(clients, [
      "src/client.tsx",
      "src/helpers/action.ts",
      "src/helpers/nested.ts",
      "src/helpers/request.ts",
      "src/helpers/session.ts"
    ]);
    assert.ok(!clients.includes("src/actions.ts"), "use-server modules are RPC boundaries");
    assert.ok(!clients.includes("src/helpers/type-only.ts"), "type-only imports do not enter the closure");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("enumerates executable source candidates independently of TypeScript Program membership", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-executable-sources-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    const included = [
      "src/app/one/page.ts",
      "src/app/two/page.tsx",
      "src/server/service.ts",
      "tools/module-command.mts",
      "tools/common-command.cts",
      "ops/arbitrary-command.ts"
    ];
    writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          jsx: "preserve",
          baseUrl: ".",
          paths: { "@/*": ["src/*"] }
        },
        files: included
      })
    );
    writeFixture(
      "package.json",
      JSON.stringify({
        scripts: {
          module: "tsx tools/module-command.mts",
          common: "tsx tools/common-command.cts",
          arbitrary: "tsx ops/arbitrary-command.ts",
          missing: "tsx tools/missing-command.mts"
        }
      })
    );
    writeFixture("src/server/service.ts", "export function load() {}\n");
    writeFixture("src/app/one/page.ts", 'import { load } from "@/server/service"; export default function Page() { load(); return null; }\n');
    writeFixture("src/app/two/page.tsx", 'import { load } from "@/server/service"; export default function Page() { load(); return null; }\n');
    writeFixture("tools/module-command.mts", "export const moduleCommand = true;\n");
    writeFixture("tools/common-command.cts", "export const commonCommand = true;\n");
    writeFixture("ops/arbitrary-command.ts", "export const arbitraryCommand = true;\n");
    writeFixture("src/unsupported/client.js", '"use client"; fetch("/api/js");\n');
    writeFixture("src/unsupported/action.mjs", '"use server"; export async function action() {}\n');
    writeFixture("src/app/unsupported/page.jsx", "export default function Page() { return null; }\n");
    writeFixture("src/app/unsupported/layout.cjs", "module.exports = function Layout() {};\n");

    const registry = buildRepositoryRegistry(temporaryRoot);
    assert.deepEqual(
      registry.owners
        .filter((owner) => owner.ownerKind === "server_loader")
        .map((owner) => owner.ownerModule),
      ["src/app/one/page.ts", "src/app/two/page.tsx"]
    );
    assert.deepEqual(
      registry.owners
        .filter((owner) => owner.ownerKind === "package_command")
        .map((owner) => owner.ownerModule)
        .sort(),
      ["ops/arbitrary-command.ts", "tools/common-command.cts", "tools/module-command.mts"]
    );
    assert.deepEqual(
      registry.diagnostics
        .filter((diagnostic) => diagnostic.code === "unsupported_executable_source")
        .map((diagnostic) => diagnostic.file)
        .sort(),
      [
        "src/app/unsupported/layout.cjs",
        "src/app/unsupported/page.jsx",
        "src/unsupported/action.mjs",
        "src/unsupported/client.js"
      ]
    );
    assert.ok(
      registry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unresolved_package_command" &&
          diagnostic.detail === "typescript_command_owner_missing:tools/missing-command.mts"
      )
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("resolves single Better Auth assignment aliases and rejects ambiguous assignment flow", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "src/lib/auth/assignment-client.ts":
      'import { createAuthClient } from "better-auth/react"; export const authClient = createAuthClient();',
    "src/features/simple-assignment.tsx":
      '"use client"; import { authClient } from "@/lib/auth/assignment-client"; let sessionApi; sessionApi = authClient; let assignedSignOut; assignedSignOut = sessionApi.signOut; sessionApi.signOut(); assignedSignOut();',
    "src/features/ambiguous-assignment.tsx":
      '"use client"; import { authClient } from "@/lib/auth/assignment-client"; declare const other: unknown; declare const method: string; let reassigned; reassigned = authClient; reassigned = other; reassigned.signOut(); let assignedMethod; assignedMethod = authClient.signOut; assignedMethod = authClient.revokeSession; assignedMethod(); let computed; computed = ({ primary: authClient })[method]; computed.signOut(); reassigned[method]();'
  });
  const simpleOwner = "src/features/simple-assignment.tsx";
  const ambiguousOwner = "src/features/ambiguous-assignment.tsx";
  const result = discoverClientBindings(program, repositoryRoot, [simpleOwner, ambiguousOwner]);
  assert.deepEqual(
    result.observations
      .filter((entry) => entry.ownerModule === simpleOwner)
      .map(({ symbol, target }) => ({ symbol, target })),
    [
      {
        symbol: "sessionApi.signOut[1]",
        target: "better-auth/react#createAuthClient.signOut"
      },
      {
        symbol: "assignedSignOut[1]",
        target: "better-auth/react#createAuthClient.signOut"
      }
    ]
  );
  assert.ok(
    result.diagnostics.filter(
      (diagnostic) =>
        diagnostic.code === "unsupported_client_binding" &&
        diagnostic.file === ambiguousOwner
    ).length >= 4,
    "reassigned, multiple-method, computed-source, and computed-member flows must fail closed"
  );
});

test("maps Dockerfile exec and shell node bundle directives to copied command owners", () => {
  const packageJsonText = JSON.stringify({
    scripts: {
      build: "npm run build:platform-owner && npm run build:integrity",
      "build:platform-owner":
        "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs",
      "build:integrity":
        "esbuild scripts/integrity-check.ts --bundle --outfile=dist/integrity-check.mjs"
    }
  });
  const dockerfileText = [
    "FROM node:22 AS runner",
    "WORKDIR /app",
    "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
    "COPY --from=builder /app/dist/integrity-check.mjs ./integrity-check.mjs",
    'ENTRYPOINT ["node", "/app/platform-owner.mjs"]',
    "CMD node ./integrity-check.mjs",
    "CMD node /app/rogue.mjs",
    'CMD node "/app/${OPERATOR}.mjs"'
  ].join("\n") + "\n";
  const discovery = discoverContainerCommandBindings(
    repositoryRoot,
    packageJsonText,
    dockerfileText,
    ""
  );
  assert.deepEqual(
    discovery.observations
      .filter((entry) => entry.kind === "container_invocation")
      .map(({ ownerModule, symbol, target, anchorFile }) => ({
        ownerModule,
        symbol,
        target,
        anchorFile
      })),
    [
      {
        ownerModule: "scripts/platform-owner.ts",
        symbol: "platform-owner.mjs",
        target: "Dockerfile#ENTRYPOINT:/app/platform-owner.mjs",
        anchorFile: "Dockerfile"
      },
      {
        ownerModule: "scripts/integrity-check.ts",
        symbol: "integrity-check.mjs",
        target: "Dockerfile#CMD:/app/integrity-check.mjs",
        anchorFile: "Dockerfile"
      }
    ]
  );
  assert.ok(
    discovery.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unsupported_container_command" &&
        diagnostic.file === "Dockerfile" &&
        diagnostic.detail === "container_invocation_copy_missing:/app/rogue.mjs"
    )
  );
  assert.ok(
    discovery.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unsupported_container_command" &&
        diagnostic.file === "Dockerfile" &&
        diagnostic.detail === "unsupported_computed_operational_mjs_invocation"
    )
  );
});

test("discovers arrow decoders, renamed parsers, static tables, and rejects dynamic command tables", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "tools/arrow.ts":
      'const parseArrowCommand = (args: readonly string[]) => { const [operation] = args; if (operation === "inspect") return { kind: "inspect" }; throw new Error("usage"); }; void parseArrowCommand(process.argv.slice(2));',
    "tools/renamed.ts":
      'const decode = function(args: readonly string[]) { const [raw] = args; const discriminant = raw; switch (discriminant) { case "repair": return { kind: "repair" }; default: throw new Error("usage"); } }; void decode(process.argv.slice(2));',
    "tools/lookup.ts":
      'function decodeLookup(args: readonly string[]) { const [operation] = args; const commands = { inspect: { kind: "inspect" }, repair: { kind: "repair" } } as const; return commands[operation]; } void decodeLookup(process.argv.slice(2));',
    "tools/dynamic.ts":
      'declare function loadCommands(): Record<string, { kind: string }>; function decodeDynamic(args: readonly string[]) { const [operation] = args; const commands = loadCommands(); return commands[operation]; } void decodeDynamic(process.argv.slice(2));'
  });
  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({
      scripts: {
        arrow: "tsx tools/arrow.ts",
        renamed: "tsx tools/renamed.ts",
        lookup: "tsx tools/lookup.ts",
        dynamic: "tsx tools/dynamic.ts"
      }
    })
  );
  assert.deepEqual(
    result.observations
      .filter((entry) => entry.kind === "command_variant")
      .map(({ ownerModule, symbol, target }) => ({ ownerModule, symbol, target })),
    [
      {
        ownerModule: "tools/arrow.ts",
        symbol: "inspect",
        target: "tools/arrow.ts#parseArrowCommand:inspect"
      },
      {
        ownerModule: "tools/renamed.ts",
        symbol: "repair",
        target: "tools/renamed.ts#decode:repair"
      },
      {
        ownerModule: "tools/lookup.ts",
        symbol: "inspect",
        target: "tools/lookup.ts#decodeLookup:inspect"
      },
      {
        ownerModule: "tools/lookup.ts",
        symbol: "repair",
        target: "tools/lookup.ts#decodeLookup:repair"
      }
    ]
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unsupported_package_command_variant" &&
        diagnostic.file === "tools/dynamic.ts" &&
        diagnostic.detail === "command_variant_lookup_table_is_not_static:decodeDynamic"
    )
  );
});

test("rejects blank declaration and gate strings and compares exact exclusion rationales", () => {
  const operationSource = (body) =>
    `import type { OperationDeclaration } from "@/server/operation-registry/schema"; export const operation = ${body} as const satisfies OperationDeclaration;`;
  const validBindingBody = validBody.replace(
    "bindings: []",
    'bindings: [{ kind: "route_method", symbol: "GET", target: "src/app/api/test/route.ts#GET" }]'
  );
  const blankBodies = [
    validBindingBody.replace('id: "test"', 'id: "   "'),
    validBindingBody.replace('ownerModule: "src/app/api/test/route.ts"', 'ownerModule: "   "'),
    validBindingBody.replace('symbol: "GET"', 'symbol: " "'),
    validBindingBody.replace('target: "src/app/api/test/route.ts#GET"', 'target: "   "'),
    validBody
      .replace('disposition: "observed"', 'disposition: "excluded"')
      .replace(
        "deferredGateIds: []",
        'exclusion: { category: "fixture", rationale: "   " }, deferredGateIds: []'
      )
  ];
  for (const [index, body] of blankBodies.entries()) {
    const parsed = parseSidecarSource(`blank-${index}.operation.ts`, operationSource(body));
    assert.ok(
      parsed.diagnostics.some((diagnostic) => diagnostic.code === "invalid_sidecar_schema"),
      `blank declaration field ${index} must fail closed`
    );
  }

  const baseline = buildDeferredGateRegistry();
  for (const malformed of [
    { ...baseline.gates[0], rationale: "   " },
    { ...baseline.gates[0], exitCriteria: "\t" },
    { ...baseline.gates[0], blockedAxes: [] },
    { ...baseline.gates[0], blockedAxes: [baseline.gates[0].blockedAxes[0], baseline.gates[0].blockedAxes[0]] },
    { ...baseline.gates[0], blockedAxes: [""] }
  ]) {
    assert.ok(
      validateGateEvidenceIntegrity(
        { ...baseline, gates: [malformed, ...baseline.gates.slice(1)] },
        new Set()
      ).some((diagnostic) => diagnostic.code === "invalid_gate_shape")
    );
  }

  const excludedSidecar = resolve(repositoryRoot, "prisma/seed.operation.ts");
  const original = readFileSync(excludedSidecar, "utf8");
  writeFileSync(
    excludedSidecar,
    original.replace(
      "seed fixture command; excluded from operation semantics",
      "different but non-empty fixture rationale"
    )
  );
  try {
    assert.ok(
      buildRepositoryRegistry(repositoryRoot).diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "declaration_disposition_mismatch" &&
          diagnostic.file === "prisma/seed.operation.ts"
      ),
      "exclusion rationale drift must not pass category-only comparison"
    );
  } finally {
    writeFileSync(excludedSidecar, original);
  }
});

test("binds declaration and versioned registry digests across every generated artifact", () => {
  const baseline = buildRepositoryArtifacts(repositoryRoot);
  assert.equal(baseline.declarationDigestVersion, "normalized-declarations.v1");
  assert.equal(
    baseline.runtimeInvocationLedgerDigestVersion,
    "selected-shell-runtime-ledger.v1"
  );
  assert.equal(baseline.registryDigestVersion, "operation-registry.v1");
  assert.match(baseline.declarationDigest, /^[a-f0-9]{64}$/);
  assert.match(baseline.deferredGateRegistryDigest, /^[a-f0-9]{64}$/);
  assert.match(baseline.runtimeInvocationLedgerDigest, /^[a-f0-9]{64}$/);
  assert.match(baseline.registryDigest, /^[a-f0-9]{64}$/);

  const parsedArtifacts = Object.values(baseline.artifacts).map((content) => JSON.parse(content));
  for (const artifact of parsedArtifacts) {
    assert.equal(artifact.declarationDigestVersion, baseline.declarationDigestVersion);
    assert.equal(artifact.declarationDigest, baseline.declarationDigest);
    assert.equal(artifact.deferredGateRegistryDigestVersion, baseline.deferredGateRegistryDigestVersion);
    assert.equal(artifact.deferredGateRegistryDigest, baseline.deferredGateRegistryDigest);
    assert.equal(
      artifact.runtimeInvocationLedgerDigestVersion,
      baseline.runtimeInvocationLedgerDigestVersion
    );
    assert.equal(
      artifact.runtimeInvocationLedgerDigest,
      baseline.runtimeInvocationLedgerDigest
    );
    assert.equal(artifact.registryDigestVersion, baseline.registryDigestVersion);
    assert.equal(artifact.registryDigest, baseline.registryDigest);
  }

  const aggregateInput = {
    ownerSetDigest: "owner",
    observationDigest: "observation",
    declarationDigest: "declaration",
    schemaDigest: "schema",
    generatorDigest: "generator",
    deferredGateRegistryBytes: "gates",
    runtimeInvocationLedgerDigest: "runtime-ledger"
  };
  const aggregate = computeRegistryDigest(aggregateInput);
  for (const [field, value] of Object.entries(aggregateInput)) {
    assert.notEqual(
      computeRegistryDigest({ ...aggregateInput, [field]: `${value}-drift` }).registryDigest,
      aggregate.registryDigest,
      `${field} drift must change the registry digest`
    );
  }

  const excludedSidecar = resolve(repositoryRoot, "prisma/seed.operation.ts");
  const original = readFileSync(excludedSidecar, "utf8");
  writeFileSync(
    excludedSidecar,
    original.replace(
      "seed fixture command; excluded from operation semantics",
      "seed fixture command; exact declaration drift"
    )
  );
  let drifted;
  try {
    drifted = buildRepositoryArtifacts(repositoryRoot);
  } finally {
    writeFileSync(excludedSidecar, original);
  }
  assert.notEqual(drifted.declarationDigest, baseline.declarationDigest);
  assert.notEqual(drifted.registryDigest, baseline.registryDigest);
  assert.equal(drifted.ownerSetDigest, baseline.ownerSetDigest);

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-aggregate-tamper-"));
  try {
    for (const [file, content] of Object.entries(baseline.artifacts)) {
      const target = resolve(temporaryRoot, file);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    const fingerprintPath = resolve(
      temporaryRoot,
      "src/server/operation-registry/generated/fingerprints.json"
    );
    const fingerprintArtifact = JSON.parse(readFileSync(fingerprintPath, "utf8"));
    fingerprintArtifact.registryDigest = "0".repeat(64);
    writeFileSync(fingerprintPath, `${JSON.stringify(fingerprintArtifact, null, 2)}\n`);
    assert.ok(
      checkGeneratedArtifacts(
        temporaryRoot,
        baseline.artifacts,
        new Set(baseline.registry.declarations.map((entry) => entry.sidecarPath))
      ).some(
        (diagnostic) =>
          diagnostic.code === "generated_artifact_mismatch" &&
          diagnostic.detail === "aggregate_metadata_cross_file_mismatch:registryDigest"
      )
    );

    const deferredPath = resolve(
      temporaryRoot,
      "src/server/operation-registry/generated/deferred-gates.json"
    );
    const deferredArtifact = JSON.parse(readFileSync(deferredPath, "utf8"));
    deferredArtifact.runtimeInvocationLedgerDigest = "1".repeat(64);
    writeFileSync(deferredPath, `${JSON.stringify(deferredArtifact, null, 2)}\n`);
    assert.ok(
      checkGeneratedArtifacts(
        temporaryRoot,
        baseline.artifacts,
        new Set(baseline.registry.declarations.map((entry) => entry.sidecarPath))
      ).some(
        (diagnostic) =>
          diagnostic.code === "generated_artifact_mismatch" &&
          diagnostic.detail ===
            "aggregate_metadata_cross_file_mismatch:runtimeInvocationLedgerDigest"
      )
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("resolves assigned global fetch aliases and rejects ambiguous assignment flow", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "src/features/assigned-fetch.tsx":
      '"use client"; let request; request = fetch; let globalRequest; globalRequest = globalThis.fetch; let windowRequest; windowRequest = window.fetch; request("/api/request"); globalRequest("/api/global"); windowRequest("/api/window");',
    "src/features/ambiguous-fetch.tsx":
      '"use client"; declare const other: typeof fetch; declare const method: string; let multiple; multiple = fetch; multiple = globalThis.fetch; multiple("/api/multiple"); let reassigned; reassigned = fetch; reassigned = other; reassigned("/api/reassigned"); let computed; computed = ({ primary: fetch })[method]; computed("/api/computed");'
  });
  const assignedOwner = "src/features/assigned-fetch.tsx";
  const ambiguousOwner = "src/features/ambiguous-fetch.tsx";
  const result = discoverClientBindings(program, repositoryRoot, [
    assignedOwner,
    ambiguousOwner
  ]);

  assert.deepEqual(
    result.observations
      .filter((entry) => entry.ownerModule === assignedOwner)
      .map(({ kind, symbol, target }) => ({ kind, symbol, target })),
    [
      { kind: "global_fetch", symbol: "request[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "globalRequest[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "windowRequest[1]", target: "globalThis.fetch" }
    ]
  );
  assert.deepEqual(
    result.diagnostics
      .filter((diagnostic) => diagnostic.file === ambiguousOwner)
      .map(({ code, detail }) => ({ code, detail })),
    [
      { code: "unsupported_client_binding", detail: "unresolved_or_wrapped_fetch_call" },
      { code: "unsupported_client_binding", detail: "unresolved_or_wrapped_fetch_call" },
      { code: "unsupported_client_binding", detail: "unresolved_or_wrapped_fetch_call" }
    ]
  );
});

test("traverses client value re-export barrels to terminal binding owners", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-client-reexports-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          baseUrl: ".",
          paths: { "@/*": ["src/*"] }
        },
        include: ["src/**/*.ts", "src/**/*.tsx"]
      })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture(
      "src/lib/auth-client.ts",
      'import { createAuthClient } from "better-auth/react"; export const authClient = createAuthClient();\n'
    );
    writeFixture(
      "src/actions.ts",
      '"use server"; export async function saveAction() { fetch("https://server.invalid"); }\n'
    );
    writeFixture(
      "src/terminal/fetch.ts",
      'export function request() { return fetch("/api/reexported"); }\n'
    );
    writeFixture(
      "src/terminal/auth.ts",
      'import { authClient } from "@/lib/auth-client"; export function signOut() { return authClient.signOut(); }\n'
    );
    writeFixture(
      "src/terminal/action.ts",
      'import { saveAction } from "@/actions"; export function save() { return saveAction(); }\n'
    );
    writeFixture(
      "src/type-only.ts",
      'export type Hidden = string; export function hiddenRequest() { return window.fetch("/api/type-only"); }\n'
    );
    writeFixture(
      "src/barrels/one.ts",
      'import { request } from "../terminal/fetch"; export { request }; export { signOut } from "../terminal/auth";\n'
    );
    writeFixture(
      "src/barrels/two.ts",
      'export * from "./one"; export { save } from "../terminal/action"; export { saveAction } from "../actions"; export type { Hidden } from "../type-only";\n'
    );
    writeFixture(
      "src/barrels/missing.ts",
      'export { missing } from "./absent";\n'
    );
    writeFixture(
      "src/client.tsx",
      '"use client"; import { request, signOut, save, saveAction } from "@/barrels/two"; import { missing } from "@/barrels/missing"; export function Client() { request(); signOut(); save(); saveAction(); void missing; return null; }\n'
    );

    const registry = buildRepositoryRegistry(temporaryRoot);
    const clientOwners = registry.owners
      .filter((owner) => owner.ownerKind === "client_binding")
      .map((owner) => owner.ownerModule)
      .sort();
    assert.deepEqual(clientOwners, [
      "src/client.tsx",
      "src/terminal/action.ts",
      "src/terminal/auth.ts",
      "src/terminal/fetch.ts"
    ]);
    assert.ok(!clientOwners.includes("src/actions.ts"), "use-server modules remain RPC boundaries");
    assert.ok(!clientOwners.includes("src/type-only.ts"), "type-only re-exports do not enter the closure");
    for (const [ownerModule, kind] of [
      ["src/terminal/fetch.ts", "global_fetch"],
      ["src/terminal/auth.ts", "auth_client_call"],
      ["src/terminal/action.ts", "server_action"]
    ]) {
      assert.ok(
        registry.owners
          .find((owner) => owner.ownerModule === ownerModule)
          ?.bindings.some((binding) => binding.kind === kind),
        `${ownerModule} must own its terminal ${kind} binding`
      );
    }
    assert.ok(
      registry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_client_binding" &&
          diagnostic.file === "src/barrels/missing.ts" &&
          diagnostic.detail === "client_value_reexport_unresolved:./absent"
      ),
      "an unresolved value re-export must fail closed"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("composes Docker exec-form ENTRYPOINT and CMD into one anchored invocation", () => {
  const packageJsonText = JSON.stringify({
    scripts: {
      build: "npm run build:platform-owner",
      "build:platform-owner":
        "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs"
    }
  });
  const dockerfile = (entrypoint, command) => [
    "FROM node:22 AS runner",
    "WORKDIR /app",
    "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
    entrypoint,
    command
  ].join("\n") + "\n";
  const composedSource = dockerfile(
    'ENTRYPOINT ["node"]',
    'CMD ["/app/platform-owner.mjs"]'
  );
  const composed = discoverContainerCommandBindings(
    repositoryRoot,
    packageJsonText,
    composedSource,
    ""
  );
  const invocations = composed.observations.filter(
    (entry) => entry.kind === "container_invocation"
  );
  assert.deepEqual(
    invocations.map(({ ownerModule, symbol, target, anchorFile }) => ({
      ownerModule,
      symbol,
      target,
      anchorFile
    })),
    [
      {
        ownerModule: "scripts/platform-owner.ts",
        symbol: "platform-owner.mjs",
        target: "Dockerfile#ENTRYPOINT+CMD:/app/platform-owner.mjs",
        anchorFile: "Dockerfile"
      }
    ]
  );
  assert.match(
    composedSource.slice(invocations[0].anchorStart, invocations[0].anchorEnd),
    /ENTRYPOINT \["node"\][\s\S]*CMD \["\/app\/platform-owner\.mjs"\]/
  );
  assert.deepEqual(composed.diagnostics, []);

  for (const [name, entrypoint, command, detail] of [
    [
      "unmatched",
      'ENTRYPOINT ["node"]',
      'CMD ["/app/rogue.mjs"]',
      "container_invocation_copy_missing:/app/rogue.mjs"
    ],
    [
      "computed",
      'ENTRYPOINT ["node"]',
      'CMD ["/app/${OPERATOR}.mjs"]',
      "unsupported_computed_operational_mjs_invocation"
    ],
    [
      "dynamic",
      'ENTRYPOINT ["node"]',
      'CMD ["$OPERATION_BUNDLE"]',
      "unsupported_dynamic_node_invocation"
    ],
    [
      "shell",
      'ENTRYPOINT ["node"]',
      "CMD node /app/platform-owner.mjs",
      "unsupported_docker_entrypoint_cmd_combination"
    ]
  ]) {
    const result = discoverContainerCommandBindings(
      repositoryRoot,
      packageJsonText,
      dockerfile(entrypoint, command),
      ""
    );
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_container_command" &&
          diagnostic.file === "Dockerfile" &&
          diagnostic.detail === detail
      ),
      `${name} ENTRYPOINT/CMD composition must fail closed`
    );
  }
});

test("tracks argv aliases and name-independent dispatcher delegation", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "tools/dispatchers.ts": [
      'const SELECT_ALIAS = "select-owner";',
      'const EXTRA_ALIAS = "decode-extra";',
      'function parseKnownCommand(args: readonly string[]) { const [operation] = args; if (operation === "known") return { kind: "known" }; throw new Error("usage"); }',
      'function selectPlatformOwnerOperation(args: readonly string[]) { const [operation] = args; return operation === SELECT_ALIAS ? { kind: SELECT_ALIAS } : null; }',
      'function delegateSelection(args: readonly string[]) { return selectPlatformOwnerOperation(args); }',
      'const decodeExtra = function(values: readonly string[]) { const operation = values[0]; if (operation === EXTRA_ALIAS) return { kind: EXTRA_ALIAS }; throw new Error("usage"); };',
      'declare function resolveOperation(value: string): { kind: string };',
      'function routeUnknown(args: readonly string[]) { const [operation] = args; return resolveOperation(operation); }',
      'function conditionalUnknown(args: readonly string[]) { const [operation] = args; return operation ? { kind: "truthy" } : { kind: "missing" }; }',
      'parseKnownCommand(process.argv.slice(2));',
      'delegateSelection(process.argv.slice(2));',
      'const argv = process.argv.slice(2);',
      'decodeExtra(argv);',
      'routeUnknown(argv);',
      'conditionalUnknown(argv);'
    ].join("\n")
  });
  const ownerModule = "tools/dispatchers.ts";
  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({ scripts: { dispatchers: "tsx tools/dispatchers.ts" } })
  );
  assert.deepEqual(
    result.observations
      .filter((entry) => entry.kind === "command_variant")
      .map(({ symbol, target }) => ({ symbol, target })),
    [
      { symbol: "known", target: `${ownerModule}#parseKnownCommand:known` },
      {
        symbol: "select-owner",
        target: `${ownerModule}#selectPlatformOwnerOperation:select-owner`
      },
      { symbol: "decode-extra", target: `${ownerModule}#decodeExtra:decode-extra` }
    ]
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unsupported_package_command_variant" &&
        diagnostic.file === ownerModule &&
        diagnostic.detail === "command_variant_dispatcher_shape_unsupported:routeUnknown"
    ),
    "an argument-rooted dispatcher that cannot be classified must fail closed"
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unsupported_package_command_variant" &&
        diagnostic.file === ownerModule &&
        diagnostic.detail === "command_variant_dispatcher_shape_unsupported:conditionalUnknown"
    ),
    "an unclassified argument-rooted conditional must fail closed"
  );
});

test("resolves single static client property assignments and rejects ambiguous property flow", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "src/features/property-fetch.tsx":
      '"use client"; const transport: any = {}; const windowTransport: any = {}; const bareTransport: any = {}; transport.request = globalThis.fetch; windowTransport.send = window.fetch; bareTransport.load = fetch; transport.request("/api/request"); windowTransport.send("/api/window"); bareTransport.load("/api/bare");',
    "src/features/ambiguous-property-fetch.tsx":
      '"use client"; declare const other: typeof fetch; declare const method: string; const multiple: any = {}; multiple.request = fetch; multiple.request = globalThis.fetch; multiple.request("/api/multiple"); const reassigned: any = {}; reassigned.send = fetch; reassigned.send = other; reassigned.send("/api/reassigned"); const computed: any = {}; computed[method] = fetch; computed[method]("/api/computed");'
  });
  const staticOwner = "src/features/property-fetch.tsx";
  const ambiguousOwner = "src/features/ambiguous-property-fetch.tsx";
  const result = discoverClientBindings(program, repositoryRoot, [staticOwner, ambiguousOwner]);

  assert.deepEqual(
    result.observations
      .filter((entry) => entry.ownerModule === staticOwner)
      .map(({ kind, symbol, target }) => ({ kind, symbol, target })),
    [
      { kind: "global_fetch", symbol: "transport.request[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "windowTransport.send[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "bareTransport.load[1]", target: "globalThis.fetch" }
    ]
  );
  assert.deepEqual(
    result.diagnostics
      .filter((diagnostic) => diagnostic.file === ambiguousOwner)
      .map(({ code, detail }) => ({ code, detail })),
    [
      { code: "unsupported_client_binding", detail: "unresolved_or_wrapped_fetch_call" },
      { code: "unsupported_client_binding", detail: "unresolved_or_wrapped_fetch_call" },
      { code: "unsupported_client_binding", detail: "unresolved_or_wrapped_fetch_call" }
    ]
  );
});

test("fails closed for higher-order delegated client binding arguments", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "src/lib/auth/higher-order-client.ts":
      'import { createAuthClient } from "better-auth/react"; export const authClient = createAuthClient();',
    "src/actions/higher-order.ts":
      '"use server"; export async function saveAction() {}',
    "src/features/higher-order-client.tsx":
      '"use client"; import { authClient } from "@/lib/auth/higher-order-client"; import { saveAction } from "@/actions/higher-order"; declare function invoke(value: unknown): void; const request = fetch; const endSession = authClient.signOut; const delegatedSession = endSession; const delegatedAction = saveAction; invoke(fetch); invoke(globalThis.fetch); invoke(window.fetch); invoke(request); invoke(authClient.signOut); invoke(endSession); invoke(delegatedSession); invoke(saveAction); invoke(delegatedAction);'
  });
  const owner = "src/features/higher-order-client.tsx";
  const result = discoverClientBindings(program, repositoryRoot, [owner]);

  assert.deepEqual(result.observations, []);
  assert.deepEqual(
    result.diagnostics.map(({ code, file, detail }) => ({ code, file, detail })),
    Array.from({ length: 9 }, () => ({
      code: "unsupported_client_binding",
      file: owner,
      detail: "unproved_higher_order_client_binding"
    }))
  );
});

test("traverses client dynamic imports and closes loader dynamic import discovery", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-dynamic-imports-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          baseUrl: ".",
          paths: { "@/*": ["src/*"] }
        },
        include: ["src/**/*.ts", "src/**/*.tsx"]
      })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture("src/network.ts", 'export function request() { return fetch("/api/dynamic"); }\n');
    writeFixture("src/actions.ts", '"use server"; export async function save() { fetch("https://server.invalid"); }\n');
    writeFixture(
      "src/client.tsx",
      '"use client"; declare const moduleName: string; export async function load() { await import("./network"); await import("./actions"); await import("./missing"); await import(moduleName); return null; }\n'
    );
    writeFixture("src/server/service.ts", "export async function load() {}\n");
    writeFixture(
      "src/app/dynamic/page.tsx",
      'export default async function Page() { await import("@/server/service"); return null; }\n'
    );
    writeFixture(
      "src/app/missing/page.tsx",
      'export default async function Page() { await import("@/server/missing"); return null; }\n'
    );
    writeFixture(
      "src/app/nonliteral/page.tsx",
      'declare const moduleName: string; export default async function Page() { await import(moduleName); return null; }\n'
    );

    const registry = buildRepositoryRegistry(temporaryRoot);
    assert.ok(
      registry.owners
        .find((owner) => owner.ownerModule === "src/network.ts")
        ?.bindings.some((binding) => binding.kind === "global_fetch"),
      "a static local client dynamic import must enter the value closure"
    );
    assert.ok(
      !registry.owners.some((owner) => owner.ownerModule === "src/actions.ts" && owner.ownerKind === "client_binding"),
      "a use-server dynamic import remains an RPC boundary"
    );
    assert.ok(
      registry.owners
        .find((owner) => owner.ownerModule === "src/app/dynamic/page.tsx")
        ?.bindings.some(
          (binding) =>
            binding.kind === "server_dynamic_import" &&
            binding.target === "src/server/service.ts"
        ),
      "a static server dynamic import must be structurally observed"
    );
    for (const [file, code, detail] of [
      ["src/client.tsx", "unsupported_client_binding", "client_dynamic_import_unresolved:./missing"],
      ["src/client.tsx", "unsupported_client_binding", "client_dynamic_import_specifier_is_not_static"],
      ["src/app/missing/page.tsx", "unresolved_loader_import", "dynamic_value_import_unresolved:@/server/missing"],
      ["src/app/nonliteral/page.tsx", "unresolved_loader_import", "dynamic_import_specifier_is_not_static"]
    ]) {
      assert.ok(
        registry.diagnostics.some(
          (diagnostic) =>
            diagnostic.file === file &&
            diagnostic.code === code &&
            diagnostic.detail === detail
        ),
        `${file} must fail closed as ${detail}`
      );
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("enumerates every configured Next app root and rejects root-app route extensions", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-app-roots-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext" },
        include: ["src/**/*.ts", "app/**/*.ts"]
      })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture("src/app/api/known/route.ts", "export function GET() {}\n");
    writeFixture("app/api/rogue/route.ts", "export function POST() {}\n");
    writeFixture("app/api/unsupported/route.js", "export function GET() {}\n");

    const registry = buildRepositoryRegistry(temporaryRoot);
    assert.deepEqual(
      registry.owners
        .filter((owner) => owner.ownerKind === "api_route")
        .map((owner) => owner.ownerModule),
      ["app/api/rogue/route.ts", "src/app/api/known/route.ts"]
    );
    assert.ok(
      registry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "observation_set_mismatch" &&
          diagnostic.file === "app/api/rogue/route.operation.ts" &&
          diagnostic.detail === "discovered_owner_not_in_appendix"
      ),
      "a root app route must reach the owner/Appendix mismatch"
    );
    assert.ok(
      registry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_route_extension" &&
          diagnostic.file === "app/api/unsupported/route.js"
      ),
      "unsupported routes under the root app directory must fail closed"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("composes static Node options with Docker CMD and rejects unsafe option compositions", () => {
  const packageJsonText = JSON.stringify({
    scripts: {
      build: "npm run build:platform-owner",
      "build:platform-owner":
        "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs"
    }
  });
  const dockerfile = (entrypoint, command) => [
    "FROM node:22 AS runner",
    "WORKDIR /app",
    "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
    entrypoint,
    command
  ].join("\n") + "\n";
  const source = dockerfile(
    'ENTRYPOINT ["node","--enable-source-maps"]',
    'CMD ["/app/platform-owner.mjs"]'
  );
  const result = discoverContainerCommandBindings(
    repositoryRoot,
    packageJsonText,
    source,
    ""
  );
  const invocations = result.observations.filter(
    (entry) => entry.kind === "container_invocation"
  );
  assert.deepEqual(
    invocations.map(({ ownerModule, target, anchorFile }) => ({ ownerModule, target, anchorFile })),
    [{
      ownerModule: "scripts/platform-owner.ts",
      target: "Dockerfile#ENTRYPOINT+CMD:/app/platform-owner.mjs",
      anchorFile: "Dockerfile"
    }]
  );
  assert.match(
    source.slice(invocations[0].anchorStart, invocations[0].anchorEnd),
    /ENTRYPOINT \["node","--enable-source-maps"\][\s\S]*CMD \["\/app\/platform-owner\.mjs"\]/
  );
  assert.deepEqual(result.diagnostics, []);

  for (const [name, entrypoint, command, detail] of [
    [
      "dynamic-option",
      'ENTRYPOINT ["node","--conditions=${NODE_CONDITIONS}"]',
      'CMD ["/app/platform-owner.mjs"]',
      "unsupported_dynamic_node_option"
    ],
    [
      "non-option-prefix",
      'ENTRYPOINT ["node","loader"]',
      'CMD ["/app/platform-owner.mjs"]',
      "unsupported_docker_entrypoint_cmd_combination"
    ],
    [
      "dynamic-command",
      'ENTRYPOINT ["node","--enable-source-maps"]',
      'CMD ["$OPERATION_BUNDLE"]',
      "unsupported_dynamic_node_invocation"
    ]
  ]) {
    const unsupported = discoverContainerCommandBindings(
      repositoryRoot,
      packageJsonText,
      dockerfile(entrypoint, command),
      ""
    );
    assert.ok(
      unsupported.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_container_command" &&
          diagnostic.file === "Dockerfile" &&
          diagnostic.detail === detail
      ),
      `${name} composition must fail closed`
    );
  }
});

test("classifies callable aliases scalar argv roots and top-level command tables", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "tools/callable.ts":
      'function runPlatformOwnerCommand(args: readonly string[]) { const [command] = args; if (command === "bind") return { kind: "bind" }; throw new Error("usage"); } const execute = runPlatformOwnerCommand; const delegated = execute; delegated(process.argv.slice(2));',
    "tools/scalar.ts":
      'function dispatch(command: string) { if (command === "inspect") return { kind: "inspect" }; throw new Error("usage"); } dispatch(process.argv[2]);',
    "tools/table.ts":
      'const handlers = { bind: () => undefined, recover: () => undefined } as const; handlers[process.argv[2]]?.();',
    "tools/ambiguous.ts":
      'declare function unknownWrapper(value: readonly string[]): void; declare function loadHandlers(): Record<string, () => void>; declare const index: number; unknownWrapper(process.argv.slice(2)); const handlers = loadHandlers(); handlers[process.argv[2]]?.(); const staticHandlers = { known: () => undefined } as const; staticHandlers[process.argv[index]]?.();'
  });
  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({
      scripts: {
        callable: "tsx tools/callable.ts",
        scalar: "tsx tools/scalar.ts",
        table: "tsx tools/table.ts",
        ambiguous: "tsx tools/ambiguous.ts"
      }
    })
  );

  assert.deepEqual(
    result.observations
      .filter((entry) => entry.kind === "command_variant")
      .map(({ ownerModule, symbol, target }) => ({ ownerModule, symbol, target })),
    [
      {
        ownerModule: "tools/callable.ts",
        symbol: "bind",
        target: "tools/callable.ts#runPlatformOwnerCommand:bind"
      },
      {
        ownerModule: "tools/scalar.ts",
        symbol: "inspect",
        target: "tools/scalar.ts#dispatch:inspect"
      },
      {
        ownerModule: "tools/table.ts",
        symbol: "bind",
        target: "tools/table.ts#handlers:bind"
      },
      {
        ownerModule: "tools/table.ts",
        symbol: "recover",
        target: "tools/table.ts#handlers:recover"
      }
    ]
  );
  for (const detail of [
    "package_argument_call_target_unresolved:unknownWrapper",
    "package_argument_dispatch_table_is_not_static:handlers",
    "package_argument_argv_index_is_not_static:staticHandlers"
  ]) {
    assert.ok(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_package_command_variant" &&
          diagnostic.file === "tools/ambiguous.ts" &&
          diagnostic.detail === detail
      ),
      `${detail} must fail closed`
    );
  }
});

test("rejects inline Server Actions in every unsupported JavaScript extension", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-inline-js-actions-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "ESNext", jsx: "preserve" },
        files: ["src/included.ts"]
      })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture("src/included.ts", "export const included = true;\n");
    writeFixture(
      "src/features/action.js",
      'export async function action() { "use server"; }\n'
    );
    writeFixture(
      "src/features/action.jsx",
      'export const action = async () => { "use server"; return <div />; };\n'
    );
    writeFixture(
      "src/features/action.mjs",
      'export const action = async function namedAction() { "use server"; };\n'
    );
    writeFixture(
      "src/features/action.cjs",
      'exports.action = async function action() { "use server"; };\n'
    );

    const registry = buildRepositoryRegistry(temporaryRoot);
    assert.deepEqual(
      registry.diagnostics
        .filter(
          (diagnostic) =>
            diagnostic.code === "unsupported_executable_source" &&
            diagnostic.detail.startsWith("unsupported_executable_source_extension:server_action:")
        )
        .map(({ file, detail }) => ({ file, detail })),
      ["cjs", "js", "jsx", "mjs"].map((extension) => ({
        file: `src/features/action.${extension}`,
        detail: `unsupported_executable_source_extension:server_action:${extension}`
      }))
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("closes executable discovery across both default App Router roots", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-app-root-closure-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          baseUrl: "."
        },
        include: ["src/**/*.ts", "app/**/*.ts", "app/**/*.tsx"]
      })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture("src/app/api/source/route.ts", "export function GET() {}\n");
    writeFixture("src/server/service.ts", "export function loadData() {}\n");
    writeFixture("app/api/root/route.ts", "export function POST() {}\n");
    writeFixture(
      "app/dashboard/page.tsx",
      'import { loadData } from "../../src/server/service"; export default function Page() { loadData(); return null; }\n'
    );
    writeFixture(
      "app/client/page.tsx",
      '"use client"; import { request } from "./request"; export default function Page() { fetch("/api/root-boundary"); request(); return null; }\n'
    );
    writeFixture(
      "app/client/request.ts",
      'export function request() { return fetch("/api/root-client"); }\n'
    );
    writeFixture(
      "app/actions.ts",
      '"use server"; export async function saveRootAction() {}\n'
    );
    for (const [file, sourceClass] of [
      ["app/api/javascript/route.js", "route"],
      ["app/unsupported/page.js", "server_loader"],
      ["app/unsupported/layout.jsx", "server_loader"],
      ["app/unsupported/client.mjs", "client"],
      ["app/unsupported/action.cjs", "server_action"]
    ]) {
      const source = sourceClass === "client"
        ? '"use client"; fetch("/api/unsupported");\n'
        : sourceClass === "server_action"
          ? '"use server"; export async function action() {}\n'
          : sourceClass === "route"
            ? "export function GET() {}\n"
            : "export default function Page() { return null; }\n";
      writeFixture(file, source);
    }

    const registry = buildRepositoryRegistry(temporaryRoot);
    const owners = new Set(registry.owners.map((owner) => `${owner.ownerKind}:${owner.ownerModule}`));
    for (const owner of [
      "api_route:app/api/root/route.ts",
      "api_route:src/app/api/source/route.ts",
      "server_loader:app/dashboard/page.tsx",
      "client_binding:app/client/page.tsx",
      "client_binding:app/client/request.ts",
      "server_action:app/actions.ts"
    ]) {
      assert.ok(owners.has(owner), `${owner} must be discovered from a default App Router root`);
    }
    assert.ok(
      registry.owners
        .find((owner) => owner.ownerModule === "app/client/request.ts")
        ?.bindings.some((binding) => binding.kind === "global_fetch"),
      "a root-app client dependency must retain its sensitive binding"
    );
    for (const file of [
      "app/actions.ts",
      "app/api/root/route.ts",
      "app/client/page.tsx",
      "app/client/request.ts",
      "app/dashboard/page.tsx"
    ]) {
      assert.ok(
        registry.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "observation_set_mismatch" &&
            diagnostic.file === file.replace(/\.(?:ts|tsx)$/, ".operation.ts") &&
            diagnostic.detail === "discovered_owner_not_in_appendix"
        ),
        `${file} must reach the owner/Appendix mismatch`
      );
    }
    assert.ok(
      registry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_route_extension" &&
          diagnostic.file === "app/api/javascript/route.js"
      )
    );
    assert.deepEqual(
      registry.diagnostics
        .filter((diagnostic) => diagnostic.code === "unsupported_executable_source")
        .map(({ file, detail }) => ({ file, detail })),
      [
        {
          file: "app/unsupported/action.cjs",
          detail: "unsupported_executable_source_extension:server_action:cjs"
        },
        {
          file: "app/unsupported/client.mjs",
          detail: "unsupported_executable_source_extension:client:mjs"
        },
        {
          file: "app/unsupported/layout.jsx",
          detail: "unsupported_executable_source_extension:server_loader:jsx"
        },
        {
          file: "app/unsupported/page.js",
          detail: "unsupported_executable_source_extension:server_loader:js"
        }
      ]
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("accounts for every sensitive client reference across aliases assignments and dynamic imports", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "src/lib/auth/reference-client.ts":
      'import { createAuthClient } from "better-auth/react"; export const authClient = createAuthClient();',
    "src/actions/reference-actions.ts":
      '"use server"; export async function saveAction() {} export async function removeAction() {}',
    "src/features/reference-client.tsx": [
      '"use client";',
      'declare const actionName: "saveAction";',
      'import { authClient } from "@/lib/auth/reference-client";',
      'import { saveAction, removeAction } from "@/actions/reference-actions";',
      'const api = { request: fetch };',
      'let assignedRequest; ({ request: assignedRequest } = { request: globalThis.fetch });',
      'let arrayRequest; [arrayRequest] = [window.fetch];',
      'api.request("/api/object"); assignedRequest("/api/object-assignment"); arrayRequest("/api/array-assignment");',
      'fetch("/api/valid"); authClient.signOut(); saveAction();',
      'void window.fetch; void authClient.revokeSession; void removeAction;',
      'const missed = fetch; void missed;',
      'export async function dynamicCalls() {',
      '  const { createAuthClient: makeAuth } = await import("better-auth/react");',
      '  const dynamicAuth = makeAuth();',
      '  const { authClient: importedAuth } = await import("@/lib/auth/reference-client");',
      '  const { saveAction: importedSave } = await import("@/actions/reference-actions");',
      '  const { [actionName]: computedAction } = await import("@/actions/reference-actions");',
      '  dynamicAuth.signOut(); importedAuth.revokeSession(); importedSave();',
      '  computedAction();',
      '}'
    ].join("\n")
  });
  const owner = "src/features/reference-client.tsx";
  const result = discoverClientBindings(program, repositoryRoot, [owner]);

  assert.deepEqual(
    result.observations.map(({ kind, symbol, target }) => ({ kind, symbol, target })),
    [
      { kind: "global_fetch", symbol: "api.request[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "assignedRequest[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "arrayRequest[1]", target: "globalThis.fetch" },
      { kind: "global_fetch", symbol: "fetch[1]", target: "globalThis.fetch" },
      {
        kind: "auth_client_call",
        symbol: "authClient.signOut[1]",
        target: "better-auth/react#createAuthClient.signOut"
      },
      {
        kind: "server_action",
        symbol: "saveAction[1]",
        target: "src/actions/reference-actions.ts#saveAction"
      },
      {
        kind: "auth_client_call",
        symbol: "dynamicAuth.signOut[1]",
        target: "better-auth/react#createAuthClient.signOut"
      },
      {
        kind: "auth_client_call",
        symbol: "importedAuth.revokeSession[1]",
        target: "better-auth/react#createAuthClient.revokeSession"
      },
      {
        kind: "server_action",
        symbol: "importedSave[1]",
        target: "src/actions/reference-actions.ts#saveAction"
      }
    ]
  );
  assert.deepEqual(
    result.diagnostics.map(({ code, file, detail }) => ({ code, file, detail })),
    [
      {
        code: "unsupported_client_binding",
        file: owner,
        detail: "sensitive_dynamic_import_binding_is_unsupported"
      },
      {
        code: "unsupported_client_binding",
        file: owner,
        detail: "sensitive_client_reference_is_not_observed:global_fetch"
      },
      {
        code: "unsupported_client_binding",
        file: owner,
        detail: "sensitive_client_reference_is_not_observed:better_auth_method"
      },
      {
        code: "unsupported_client_binding",
        file: owner,
        detail: "sensitive_client_reference_is_not_observed:server_action"
      },
      {
        code: "unsupported_client_binding",
        file: owner,
        detail: "sensitive_client_reference_is_not_observed:global_fetch"
      }
    ],
    "each unconsumed sensitive source must fail even beside valid observations"
  );
});

test("discovers statically registered workers without filename or start-name conventions", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-static-worker-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          baseUrl: ".",
          paths: { "@/*": ["src/*"] }
        },
        include: ["src/**/*.ts"]
      })
    );
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture(
      "src/server/services/job.ts",
      "export async function runJob() {}\n"
    );
    writeFixture(
      "src/server/background-jobs.ts",
      'import { runJob } from "@/server/services/job"; export function bootWorker() { const cycle = async () => { await runJob(); }; void cycle(); setInterval(() => { void cycle(); }, 1000); }\n'
    );
    writeFixture(
      "src/server/broken-worker.ts",
      "export function initializeBrokenWorker() {}\n"
    );
    writeFixture(
      "src/worker-barrel.ts",
      'export { bootWorker as launchWorker } from "./server/background-jobs"; export { initializeBrokenWorker } from "./server/broken-worker";\n'
    );
    writeFixture(
      "src/instrumentation.ts",
      'import { launchWorker as initialize, initializeBrokenWorker } from "./worker-barrel"; export function register() { initialize(); initializeBrokenWorker(); }\n'
    );

    const registry = buildRepositoryRegistry(temporaryRoot);
    const instrumentation = registry.owners.find(
      (owner) => owner.ownerModule === "src/instrumentation.ts"
    );
    assert.deepEqual(
      instrumentation?.bindings.map(({ kind, symbol, target }) => ({ kind, symbol, target })),
      [
        {
          kind: "worker_start_call",
          symbol: "initialize",
          target: "src/server/background-jobs.ts#bootWorker"
        },
        {
          kind: "worker_start_call",
          symbol: "initializeBrokenWorker",
          target: "src/server/broken-worker.ts#initializeBrokenWorker"
        },
        {
          kind: "worker_static_import",
          symbol: "initialize",
          target: "src/server/background-jobs.ts#bootWorker"
        },
        {
          kind: "worker_static_import",
          symbol: "initializeBrokenWorker",
          target: "src/server/broken-worker.ts#initializeBrokenWorker"
        }
      ]
    );
    assert.deepEqual(
      registry.owners
        .find((owner) => owner.ownerModule === "src/server/background-jobs.ts")
        ?.bindings.map(({ kind, symbol, target }) => ({ kind, symbol, target })),
      [
        {
          kind: "worker_schedule",
          symbol: "cycle",
          target: "src/server/background-jobs.ts#cycle"
        },
        {
          kind: "worker_start_call",
          symbol: "bootWorker",
          target: "src/server/background-jobs.ts#bootWorker"
        },
        {
          kind: "worker_tick",
          symbol: "cycle",
          target: "src/server/services/job.ts#runJob"
        }
      ]
    );
    assert.ok(
      registry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "observation_set_mismatch" &&
          diagnostic.file === "src/server/background-jobs.operation.ts" &&
          diagnostic.detail === "discovered_owner_not_in_appendix"
      ),
      "a static worker must reach owner/Appendix closure"
    );
    assert.ok(
      registry.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_worker_wiring" &&
          diagnostic.file === "src/server/broken-worker.ts" &&
          diagnostic.detail === "worker_tick_function_unresolved"
      ),
      "an imported server worker without exact structure must fail closed"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("accounts for aliased argv roots top-level scalar dispatch and JavaScript node owners", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "tools/operator.ts": [
      "const runtime = process;",
      "const { argv } = runtime;",
      "const command = argv[2];",
      'if (command === "inspect") void 0;',
      'switch (command) { case "repair": break; default: break; }',
      'const selected = command === "restore" ? "yes" : "no";',
      "void selected;",
      'if (process.argv[3] === "unclassified") void 0;'
    ].join("\n"),
    "arbitrary/typed-owner.cts": "export const typedOwner = true;"
  });
  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({
      scripts: {
        operator: "tsx tools/operator.ts",
        typed: "tsx arbitrary/typed-owner.cts",
        esm: "node --enable-source-maps tools/operator.mjs",
        common: "node tools/operator.cjs",
        javascript: "node tools/operator.js",
        jsx: "node tools/operator.jsx",
        brand: "node scripts/generate-brand-icons.mjs"
      }
    })
  );

  assert.deepEqual(
    result.observations
      .filter((entry) => entry.kind === "package_script")
      .map(({ ownerModule, symbol }) => ({ ownerModule, symbol })),
    [
      { ownerModule: "tools/operator.ts", symbol: "operator" },
      { ownerModule: "arbitrary/typed-owner.cts", symbol: "typed" }
    ]
  );
  assert.deepEqual(
    result.observations
      .filter((entry) => entry.kind === "command_variant")
      .map(({ symbol, target }) => ({ symbol, target })),
    [
      { symbol: "inspect", target: "tools/operator.ts#command:inspect" },
      { symbol: "repair", target: "tools/operator.ts#command:repair" },
      { symbol: "restore", target: "tools/operator.ts#command:restore" }
    ]
  );
  assert.ok(
    result.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "unsupported_package_command_variant" &&
        diagnostic.file === "tools/operator.ts" &&
        diagnostic.detail === "unclassified_process_argv_root:process.argv[3]"
    ),
    "one unclassified argv root must fail beside classified variants"
  );
  assert.deepEqual(
    result.diagnostics
      .filter((diagnostic) => diagnostic.code === "unsupported_package_command_owner")
      .map(({ file, detail }) => ({ file, detail })),
    ["mjs", "cjs", "js", "jsx"].map((extension) => ({
      file: "package.json",
      detail: `unsupported_package_command_extension:${extension}:tools/operator.${extension}`
    }))
  );
  assert.ok(
    !result.diagnostics.some((diagnostic) =>
      diagnostic.detail.includes("scripts/generate-brand-icons.mjs")
    ),
    "the exact protected brand build entrypoint remains excluded"
  );
});

test("parses shell-form Node options before static container executables", () => {
  const packageJsonText = JSON.stringify({
    scripts: {
      build: "npm run build:platform-owner && npm run build:integrity",
      "build:platform-owner":
        "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs",
      "build:integrity":
        "esbuild scripts/integrity-check.ts --bundle --outfile=dist/integrity-check.mjs"
    }
  });
  const dockerfileText = [
    "FROM node:22 AS runner",
    "WORKDIR /app",
    "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
    "COPY --from=builder /app/dist/integrity-check.mjs ./integrity-check.mjs",
    "CMD node --enable-source-maps --conditions production /app/platform-owner.mjs"
  ].join("\n") + "\n";
  const entrypointText = [
    "#!/bin/sh",
    "node node_modules/prisma/build/index.js migrate deploy",
    "exec node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON /app/integrity-check.mjs"
  ].join("\n") + "\n";
  const result = discoverContainerCommandBindings(
    repositoryRoot,
    packageJsonText,
    dockerfileText,
    entrypointText
  );
  assert.deepEqual(
    result.observations
      .filter((entry) => entry.kind === "container_invocation")
      .map(({ ownerModule, target, anchorFile }) => ({ ownerModule, target, anchorFile })),
    [
      {
        ownerModule: "scripts/platform-owner.ts",
        target: "Dockerfile#CMD:/app/platform-owner.mjs",
        anchorFile: "Dockerfile"
      },
      {
        ownerModule: "scripts/integrity-check.ts",
        target: "docker/entrypoint.sh#/app/integrity-check.mjs",
        anchorFile: "docker/entrypoint.sh"
      }
    ]
  );
  assert.deepEqual(result.diagnostics, [{
    code: "unsupported_container_command",
    file: "docker/entrypoint.sh",
    detail:
      "container_invocation_copy_missing:/app/node_modules/prisma/build/index.js"
  }]);

  for (const [source, detail] of [
    [
      "CMD node --eval 'process.exit(0)' /app/platform-owner.mjs\n",
      "unsupported_static_node_option:--eval"
    ],
    [
      'CMD node --conditions="$NODE_CONDITIONS" /app/platform-owner.mjs\n',
      "unsupported_dynamic_node_option"
    ],
    [
      'CMD node --enable-source-maps "$OPERATION_BUNDLE"\n',
      "unsupported_dynamic_node_invocation"
    ]
  ]) {
    const unsupported = discoverContainerCommandBindings(
      repositoryRoot,
      packageJsonText,
      [
        "FROM node:22 AS runner",
        "WORKDIR /app",
        "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
        source.trimEnd()
      ].join("\n") + "\n",
      ""
    );
    assert.ok(
      unsupported.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "unsupported_container_command" &&
          diagnostic.file === "Dockerfile" &&
          diagnostic.detail === detail
      ),
      `${detail} must fail closed`
    );
  }
});

test("rejects every unexpected generated file and directory without writing", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-generated-tree-"));
  try {
    const expected = Object.fromEntries([
      "src/server/operation-registry/generated/observation-registry.json",
      "src/server/operation-registry/generated/fingerprints.json",
      "src/server/operation-registry/generated/deferred-gates.json"
    ].map((file) => [file, "{}\n"]));
    for (const [file, content] of Object.entries(expected)) {
      const target = resolve(temporaryRoot, file);
      mkdirSync(resolve(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    writeFileSync(
      resolve(temporaryRoot, "src/server/operation-registry/generated/extra.json"),
      "{}\n"
    );
    mkdirSync(
      resolve(temporaryRoot, "src/server/operation-registry/generated/rogue"),
      { recursive: true }
    );
    writeFileSync(
      resolve(temporaryRoot, "src/server/operation-registry/generated/rogue/nested.txt"),
      "unexpected\n"
    );
    const before = snapshotTree(temporaryRoot);

    const diagnostics = checkGeneratedArtifacts(temporaryRoot, expected, new Set());

    assert.deepEqual(
      diagnostics
        .filter((diagnostic) => diagnostic.code === "unexpected_generated_artifact")
        .map(({ file, detail }) => ({ file, detail })),
      [
        {
          file: "src/server/operation-registry/generated/extra.json",
          detail: "unexpected_generated_file"
        },
        {
          file: "src/server/operation-registry/generated/rogue",
          detail: "unexpected_generated_directory"
        },
        {
          file: "src/server/operation-registry/generated/rogue/nested.txt",
          detail: "unexpected_generated_file"
        }
      ]
    );
    assert.deepEqual(snapshotTree(temporaryRoot), before, "check mode must not write");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("accounts for every sensitive client dynamic import span", () => {
  const owner = "src/features/dynamic-sensitive-client.tsx";
  const program = createProgramFromSources(repositoryRoot, {
    "src/actions/dynamic-actions.ts": [
      '"use server";',
      "export async function saveAction() {}"
    ].join("\n"),
    [owner]: [
      '"use client";',
      "export async function runDynamicBindings() {",
      '  const inlineAuth = (await import("better-auth/react")).createAuthClient();',
      "  inlineAuth.signOut();",
      '  const { createAuthClient: importedFactory } = await import("better-auth/react");',
      "  const factoryAlias = importedFactory;",
      "  const aliasedAuth = factoryAlias();",
      "  aliasedAuth.revokeSession();",
      '  const { saveAction: importedSave } = await import("@/actions/dynamic-actions");',
      "  const saveAlias = importedSave;",
      "  saveAlias();",
      '  const unconsumedActions = await import("@/actions/dynamic-actions");',
      "  void unconsumedActions;",
      "}"
    ].join("\n")
  });

  const result = discoverClientBindings(program, repositoryRoot, [owner]);
  assert.deepEqual(
    result.observations.map(({ kind, symbol, target }) => ({ kind, symbol, target })),
    [
      {
        kind: "auth_client_call",
        symbol: "inlineAuth.signOut[1]",
        target: "better-auth/react#createAuthClient.signOut"
      },
      {
        kind: "auth_client_call",
        symbol: "aliasedAuth.revokeSession[1]",
        target: "better-auth/react#createAuthClient.revokeSession"
      },
      {
        kind: "server_action",
        symbol: "saveAlias[1]",
        target: "src/actions/dynamic-actions.ts#saveAction"
      }
    ]
  );
  assert.deepEqual(
    result.diagnostics.map(({ code, file, detail }) => ({ code, file, detail })),
    [{
      code: "unsupported_client_binding",
      file: owner,
      detail: "sensitive_dynamic_import_is_not_consumed"
    }]
  );
});

test("traverses both app-root loader graphs to a cycle-safe fixed point", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "src/app/page.tsx": [
      'import { renderPage } from "@/features/loader-a";',
      "export default async function Page() { await renderPage(); return null; }"
    ].join("\n"),
    "app/admin/page.tsx": [
      "export default async function Page() {",
      '  const module = await import("../../src/features/loader-barrel");',
      "  await module.serverCall();",
      "  return null;",
      "}"
    ].join("\n"),
    "src/features/loader-a.ts": [
      'import { direct as renamed } from "@/server/services/loader-direct";',
      'export { serverCall } from "./loader-barrel";',
      'import "./loader-cycle";',
      "const computed = \"@/server/services/hidden\";",
      "void import(computed);",
      'void import("@/server/services/loader-dynamic");',
      "export async function renderPage() { await renamed(); }"
    ].join("\n"),
    "src/features/loader-barrel.ts":
      'export { reexported as serverCall } from "@/server/services/loader-reexported";\n',
    "src/features/loader-cycle.ts": 'import "./loader-a"; export const cycle = true;\n',
    "src/server/services/loader-direct.ts": "export async function direct() {}\n",
    "src/server/services/loader-dynamic.ts": "export async function dynamic() {}\n",
    "src/server/services/loader-reexported.ts": "export async function reexported() {}\n",
    "src/server/services/hidden.ts": "export async function hidden() {}\n"
  });

  const result = discoverServerLoaderBindings(program, repositoryRoot, [
    "src/app/page.tsx",
    "app/admin/page.tsx"
  ]);
  assert.deepEqual(
    result.observations.map(({ kind, ownerModule, symbol, target, anchorFile }) => ({
      kind,
      ownerModule,
      symbol,
      target,
      anchorFile
    })),
    [
      {
        kind: "server_value_import",
        ownerModule: "src/app/page.tsx",
        symbol: "renamed",
        target: "src/server/services/loader-direct.ts#direct",
        anchorFile: "src/features/loader-a.ts"
      },
      {
        kind: "server_value_import",
        ownerModule: "src/app/page.tsx",
        symbol: "serverCall",
        target: "src/server/services/loader-reexported.ts#reexported",
        anchorFile: "src/features/loader-barrel.ts"
      },
      {
        kind: "server_dynamic_import",
        ownerModule: "src/app/page.tsx",
        symbol: 'import("@/server/services/loader-dynamic")[1]',
        target: "src/server/services/loader-dynamic.ts",
        anchorFile: "src/features/loader-a.ts"
      },
      {
        kind: "server_value_import",
        ownerModule: "app/admin/page.tsx",
        symbol: "serverCall",
        target: "src/server/services/loader-reexported.ts#reexported",
        anchorFile: "src/features/loader-barrel.ts"
      }
    ]
  );
  assert.ok(
    result.diagnostics.some(
      ({ code, file, detail }) =>
        code === "unresolved_loader_import" &&
        file === "src/app/page.tsx" &&
        detail === "dynamic_import_specifier_is_not_static:src/features/loader-a.ts"
    )
  );
});

test("closes the instrumentation registration graph across import forms", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-worker-graph-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  const worker = (name, service) => [
    `import { ${service} } from "@/server/services/jobs";`,
    `export function ${name}() {`,
    `  const tick = async () => { await ${service}(); };`,
    "  void tick();",
    "  setInterval(() => { void tick(); }, 1000);",
    "}"
  ].join("\n");
  try {
    writeFixture("tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@/*": ["src/*"] }
      },
      include: ["src/**/*.ts"]
    }));
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture(
      "src/server/services/jobs.ts",
      "export async function runNamed() {} export async function runNamespace() {} export async function runDefault() {} export async function runDynamic() {} export async function runUnused() {}\n"
    );
    writeFixture("src/server/named-worker.ts", worker("startNamed", "runNamed"));
    writeFixture("src/server/namespace-worker.ts", worker("startNamespace", "runNamespace"));
    writeFixture("src/server/default-worker.ts", worker("startDefault", "runDefault") + "\nexport default startDefault;\n");
    writeFixture("src/server/dynamic-worker.ts", worker("startDynamic", "runDynamic"));
    writeFixture("src/server/unused-worker.ts", worker("startUnused", "runUnused"));
    writeFixture(
      "src/worker-barrel.ts",
      [
        'export { startNamed as launchNamed } from "./server/named-worker";',
        'export { startNamespace as launchNamespace } from "./server/namespace-worker";',
        'export { default } from "./server/default-worker";'
      ].join("\n")
    );
    writeFixture(
      "src/instrumentation.ts",
      [
        'import defaultLaunch from "./worker-barrel";',
        'import * as workers from "./worker-barrel";',
        'import { launchNamed as imported } from "./worker-barrel";',
        'import { startUnused } from "@/server/unused-worker";',
        "const alias = imported;",
        "export async function register() {",
        "  alias();",
        "  workers.launchNamespace();",
        "  defaultLaunch();",
        '  const { startDynamic: dynamicAlias } = await import("@/server/dynamic-worker");',
        "  dynamicAlias();",
        "  void startUnused;",
        "}"
      ].join("\n")
    );

    const registry = buildRepositoryRegistry(temporaryRoot);
    const instrumentation = registry.owners.find(
      (owner) => owner.ownerModule === "src/instrumentation.ts"
    );
    assert.deepEqual(
      new Set(
        instrumentation?.bindings
          .filter(({ kind }) => kind === "worker_static_import")
          .map(({ target }) => target)
      ),
      new Set([
        "src/server/named-worker.ts#startNamed",
        "src/server/namespace-worker.ts#startNamespace",
        "src/server/default-worker.ts#startDefault",
        "src/server/unused-worker.ts#startUnused"
      ])
    );
    assert.deepEqual(
      new Set(
        instrumentation?.bindings
          .filter(({ kind }) => kind === "worker_dynamic_import")
          .map(({ target }) => target)
      ),
      new Set(["src/server/dynamic-worker.ts#startDynamic"])
    );
    assert.deepEqual(
      new Set(
        instrumentation?.bindings
          .filter(({ kind }) => kind === "worker_start_call")
          .map(({ target }) => target)
      ),
      new Set([
        "src/server/named-worker.ts#startNamed",
        "src/server/namespace-worker.ts#startNamespace",
        "src/server/default-worker.ts#startDefault",
        "src/server/dynamic-worker.ts#startDynamic"
      ])
    );
    for (const ownerModule of [
      "src/server/named-worker.ts",
      "src/server/namespace-worker.ts",
      "src/server/default-worker.ts",
      "src/server/dynamic-worker.ts",
      "src/server/unused-worker.ts"
    ]) {
      assert.ok(
        registry.diagnostics.some(
          ({ code, file, detail }) =>
            code === "observation_set_mismatch" &&
            file === ownerModule.replace(/\.ts$/, ".operation.ts") &&
            detail === "discovered_owner_not_in_appendix"
        ),
        `${ownerModule} must reach owner/Appendix closure`
      );
    }
    assert.ok(
      registry.diagnostics.some(
        ({ code, file, detail }) =>
          code === "unsupported_worker_wiring" &&
          file === "src/instrumentation.ts" &&
          detail === "instrumentation_value_reference_is_not_registered:startUnused"
      )
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("accounts for computed and later-assigned process argv roots", () => {
  const owner = "tools/later-argv.ts";
  const program = createProgramFromSources(repositoryRoot, {
    [owner]: [
      "let runtime;",
      "runtime = process;",
      "let args;",
      'args = runtime["argv"];',
      "let command;",
      "command = args[2];",
      'if (command === "inspect") void 0;',
      "let destructured;",
      "({ argv: destructured } = runtime);",
      "let selected;",
      "[selected] = destructured.slice(2);",
      'switch (selected) { case "repair": break; default: break; }',
      'const unsafe = process["argv"][3];',
      "void unsafe;"
    ].join("\n")
  });

  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({ scripts: { later: "tsx tools/later-argv.ts" } })
  );
  assert.deepEqual(
    result.observations
      .filter(({ kind }) => kind === "command_variant")
      .map(({ symbol }) => symbol),
    ["inspect", "repair"]
  );
  assert.deepEqual(
    result.diagnostics.map(({ code, file, detail }) => ({ code, file, detail })),
    [{
      code: "unsupported_package_command_variant",
      file: owner,
      detail: 'unclassified_process_argv_root:process["argv"][3]'
    }]
  );
});

test("enumerates existing package entrypoint tokens independently of runner", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-package-universe-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture("tsconfig.json", JSON.stringify({
      compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler" },
      include: ["scripts/**/*.ts", "tools/**/*.cts"]
    }));
    writeFixture("scripts/source.ts", "export const source = true;\n");
    writeFixture("tools/operator.cts", "export const operator = true;\n");
    writeFixture("scripts/operator.mjs", "export const operator = true;\n");
    writeFixture("dist/generated.mjs", "export const generated = true;\n");
    writeFixture("scripts/generate-brand-icons.mjs", "export const brand = true;\n");
    const packageJsonText = JSON.stringify({
      scripts: {
        source: "custom-runner scripts/source.ts",
        typed: "arbitrary-runner tools/operator.cts",
        javascript: "tsx scripts/operator.mjs",
        bundle: "esbuild scripts/source.ts --bundle --outfile dist/generated.mjs",
        brand: "asset-runner scripts/generate-brand-icons.mjs"
      }
    });
    writeFixture("package.json", packageJsonText);
    const result = discoverPackageCommands(
      loadRepositoryProgram(temporaryRoot),
      temporaryRoot,
      packageJsonText
    );

    assert.deepEqual(
      new Set(
        result.observations
          .filter(({ kind }) => kind === "package_script")
          .map(({ ownerModule }) => ownerModule)
      ),
      new Set(["scripts/source.ts", "tools/operator.cts"])
    );
    assert.deepEqual(
      result.diagnostics
        .filter(({ code }) => code === "unsupported_package_command_owner")
        .map(({ file, detail }) => ({ file, detail })),
      [{
        file: "package.json",
        detail: "unsupported_package_command_extension:mjs:scripts/operator.mjs"
      }]
    );
    assert.ok(
      !result.diagnostics.some(({ detail }) =>
        detail.includes("dist/generated.mjs") ||
        detail.includes("scripts/generate-brand-icons.mjs")
      )
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("accounts for every container Node argv code module", () => {
  const packageJsonText = JSON.stringify({
    scripts: {
      build: "npm run build:platform-owner && npm run build:integrity",
      "build:platform-owner":
        "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs",
      "build:integrity":
        "esbuild scripts/integrity-check.ts --bundle --outfile=dist/integrity-check.mjs"
    }
  });
  const dockerfileText = [
    "FROM node:22 AS runner",
    "WORKDIR /app",
    "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
    "COPY --from=builder /app/dist/integrity-check.mjs ./integrity-check.mjs",
    'ENTRYPOINT ["/usr/bin/node","--import","/app/integrity-check.mjs"]',
    'CMD ["/app/platform-owner.mjs"]'
  ].join("\n") + "\n";
  const result = discoverContainerCommandBindings(
    repositoryRoot,
    packageJsonText,
    dockerfileText,
    ""
  );
  assert.deepEqual(
    result.observations
      .filter(({ kind }) => kind === "container_invocation")
      .map(({ ownerModule, target, anchorFile }) => ({ ownerModule, target, anchorFile })),
    [
      {
        ownerModule: "scripts/integrity-check.ts",
        target: "Dockerfile#ENTRYPOINT+CMD:--import:/app/integrity-check.mjs",
        anchorFile: "Dockerfile"
      },
      {
        ownerModule: "scripts/platform-owner.ts",
        target: "Dockerfile#ENTRYPOINT+CMD:/app/platform-owner.mjs",
        anchorFile: "Dockerfile"
      }
    ]
  );
  assert.deepEqual(result.diagnostics, []);

  const shell = discoverContainerCommandBindings(
    repositoryRoot,
    packageJsonText,
    dockerfileText.replace(/ENTRYPOINT[^\n]+\nCMD[^\n]+\n/, ""),
    "exec /usr/local/bin/node --require=/app/integrity-check.mjs /app/platform-owner.mjs\n"
  );
  assert.deepEqual(
    shell.observations
      .filter(({ kind }) => kind === "container_invocation")
      .map(({ ownerModule, target }) => ({ ownerModule, target })),
    [
      {
        ownerModule: "scripts/integrity-check.ts",
        target: "docker/entrypoint.sh#--require:/app/integrity-check.mjs"
      },
      {
        ownerModule: "scripts/platform-owner.ts",
        target: "docker/entrypoint.sh#/app/platform-owner.mjs"
      }
    ]
  );
  assert.deepEqual(shell.diagnostics, []);

  for (const [entrypointText, detail] of [
    [
      'exec node --import "$CUBBY_PRELOAD" /app/platform-owner.mjs\n',
      "unsupported_dynamic_node_option"
    ],
    [
      "exec node --loader /app/missing.mjs /app/platform-owner.mjs\n",
      "container_invocation_copy_missing:/app/missing.mjs"
    ]
  ]) {
    const unsupported = discoverContainerCommandBindings(
      repositoryRoot,
      packageJsonText,
      dockerfileText.replace(/ENTRYPOINT[^\n]+\nCMD[^\n]+\n/, ""),
      entrypointText
    );
    assert.ok(
      unsupported.diagnostics.some(
        ({ code, file, detail: actual }) =>
          code === "unsupported_container_command" &&
          file === "docker/entrypoint.sh" &&
          actual === detail
      ),
      `${detail} must fail closed`
    );
  }
});

test("enumerates and composes Compose operational command overrides", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-compose-overrides-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture("package.json", JSON.stringify({
      scripts: {
        build: "npm run build:platform-owner && npm run build:integrity",
        "build:platform-owner":
          "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs",
        "build:integrity":
          "esbuild scripts/integrity-check.ts --bundle --outfile=dist/integrity-check.mjs"
      }
    }));
    writeFixture("Dockerfile", [
      "FROM node:22 AS runner",
      "WORKDIR /app",
      "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
      "COPY --from=builder /app/dist/integrity-check.mjs ./integrity-check.mjs"
    ].join("\n") + "\n");
    writeFixture("docker-compose.yml", "services:\n  app:\n    image: cubby\n");
    writeFixture(
      "compose.override.yml",
      'services:\n  app:\n    entrypoint: ["node", "/app/platform-owner.mjs"]\n'
    );
    writeFixture(
      "compose.block.yaml",
      [
        "services:",
        "  app:",
        "    entrypoint:",
        "      - /usr/bin/node",
        "    command:",
        "      - --require",
        "      - /app/integrity-check.mjs",
        "      - /app/platform-owner.mjs"
      ].join("\n") + "\n"
    );
    writeFixture(
      "compose.dynamic.yml",
      'services:\n  app:\n    entrypoint: ["node", "${CUBBY_OPERATION}"]\n'
    );

    const result = discoverContainerCommandBindings(temporaryRoot);
    assert.deepEqual(
      result.observations
        .filter(({ kind }) => kind === "container_invocation")
        .map(({ ownerModule, target, anchorFile }) => ({ ownerModule, target, anchorFile })),
      [
        {
          ownerModule: "scripts/platform-owner.ts",
          target: "compose.override.yml#services.app.entrypoint:/app/platform-owner.mjs",
          anchorFile: "compose.override.yml"
        },
        {
          ownerModule: "scripts/integrity-check.ts",
          target: "compose.block.yaml#services.app.entrypoint+command:--require:/app/integrity-check.mjs",
          anchorFile: "compose.block.yaml"
        },
        {
          ownerModule: "scripts/platform-owner.ts",
          target: "compose.block.yaml#services.app.entrypoint+command:/app/platform-owner.mjs",
          anchorFile: "compose.block.yaml"
        }
      ]
    );
    assert.ok(
      result.diagnostics.some(
        ({ code, file, detail }) =>
          code === "unsupported_container_command" &&
          file === "compose.dynamic.yml" &&
          detail === "unsupported_dynamic_node_invocation"
      )
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("twelfth remediation accounts for resolved Compose healthcheck Node roots", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-compose-healthchecks-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture("package.json", JSON.stringify({
      scripts: {
        build: "npm run build:platform-owner && npm run build:integrity",
        "build:platform-owner":
          "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs",
        "build:integrity":
          "esbuild scripts/integrity-check.ts --bundle --outfile=dist/integrity-check.mjs"
      }
    }));
    writeFixture("Dockerfile", [
      "FROM node:22 AS runner",
      "WORKDIR /app",
      "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
      "COPY --from=builder /app/dist/integrity-check.mjs ./integrity-check.mjs"
    ].join("\n") + "\n");
    const composeSource = [
      'x-probe: &probe ["CMD", "node", "--eval", "process.exit(0)"]',
      'x-scalar-probe: &scalar_probe node -e "process.exit(0)"',
      "x-healthcheck: &healthcheck",
      '  test: ["CMD-SHELL", "node -e \\"process.exit(0)\\""]',
      "services:",
      "  direct_cmd:",
      "    healthcheck:",
      '      test: ["CMD", "node", "-e", "process.exit(0)"]',
      "  direct_cmd_shell:",
      "    healthcheck:",
      '      test: ["CMD-SHELL", "node --eval \\"process.exit(0)\\""]',
      "  direct_scalar:",
      "    healthcheck:",
      '      test: node -e "process.exit(0)"',
      "  aliased_test:",
      "    healthcheck:",
      "      test: *probe",
      "  aliased_scalar_test:",
      "    healthcheck:",
      "      test: *scalar_probe",
      "  aliased_healthcheck:",
      "    healthcheck: *healthcheck",
      "  mapped_main:",
      "    healthcheck:",
      '      test: ["CMD", "node", "/app/platform-owner.mjs"]',
      "  mapped_code_loader:",
      "    healthcheck:",
      '      test: ["CMD", "node", "--require", "/app/integrity-check.mjs", "/app/platform-owner.mjs"]',
      "  eval_repository_loader:",
      "    healthcheck:",
      '      test: ["CMD", "node", "-e", "require(\'/app/platform-owner.mjs\')"]',
      "  unknown_static:",
      "    healthcheck:",
      '      test: ["CMD", "node", "/app/missing.mjs"]',
      "  dynamic_root:",
      "    healthcheck:",
      '      test: ["CMD", "${NODE_BIN:-node}", "/app/platform-owner.mjs"]',
      "  unsupported_root:",
      "    healthcheck:",
      "      test: { executable: node, module: /app/platform-owner.mjs }"
    ].join("\n") + "\n";
    writeFixture("compose.healthchecks.yml", composeSource);

    const result = discoverContainerCommandBindings(temporaryRoot);
    assert.deepEqual(
      result.runtimeInvocationLedger
        ?.filter(({ disposition }) => disposition === "structural_exclusion")
        .map(({ path, codeOption, exclusion, anchorFile, anchorBytes }) => ({
          path,
          codeOption,
          category: exclusion?.category,
          anchorFile,
          anchorBytes
        })),
      [
        {
          path: null,
          codeOption: "-e",
          category: "healthcheck_probe_runtime",
          anchorFile: "compose.healthchecks.yml",
          anchorBytes: ' ["CMD", "node", "-e", "process.exit(0)"]'
        },
        {
          path: null,
          codeOption: "--eval",
          category: "healthcheck_probe_runtime",
          anchorFile: "compose.healthchecks.yml",
          anchorBytes: ' ["CMD-SHELL", "node --eval \\"process.exit(0)\\""]'
        },
        {
          path: null,
          codeOption: "-e",
          category: "healthcheck_probe_runtime",
          anchorFile: "compose.healthchecks.yml",
          anchorBytes: ' node -e "process.exit(0)"'
        },
        {
          path: null,
          codeOption: "--eval",
          category: "healthcheck_probe_runtime",
          anchorFile: "compose.healthchecks.yml",
          anchorBytes: ' &probe ["CMD", "node", "--eval", "process.exit(0)"]'
        },
        {
          path: null,
          codeOption: "-e",
          category: "healthcheck_probe_runtime",
          anchorFile: "compose.healthchecks.yml",
          anchorBytes: '&scalar_probe node -e "process.exit(0)"'
        },
        {
          path: null,
          codeOption: "-e",
          category: "healthcheck_probe_runtime",
          anchorFile: "compose.healthchecks.yml",
          anchorBytes: ' ["CMD-SHELL", "node -e \\"process.exit(0)\\""]'
        }
      ]
    );
    assert.deepEqual(
      result.observations
        .filter(({ kind, anchorFile }) =>
          kind === "container_invocation" && anchorFile === "compose.healthchecks.yml"
        )
        .map(({ ownerModule, target }) => ({ ownerModule, target })),
      [
        {
          ownerModule: "scripts/platform-owner.ts",
          target:
            "compose.healthchecks.yml#services.mapped_main.healthcheck.test:/app/platform-owner.mjs"
        },
        {
          ownerModule: "scripts/integrity-check.ts",
          target:
            "compose.healthchecks.yml#services.mapped_code_loader.healthcheck.test:--require:/app/integrity-check.mjs"
        },
        {
          ownerModule: "scripts/platform-owner.ts",
          target:
            "compose.healthchecks.yml#services.mapped_code_loader.healthcheck.test:/app/platform-owner.mjs"
        },
        {
          ownerModule: "scripts/platform-owner.ts",
          target:
            "compose.healthchecks.yml#services.eval_repository_loader.healthcheck.test:-e:/app/platform-owner.mjs"
        }
      ]
    );
    assert.deepEqual(
      new Set(
        result.diagnostics
          .filter(({ code, file }) =>
            code === "unsupported_container_command" &&
            file === "compose.healthchecks.yml"
          )
          .map(({ detail }) => detail)
      ),
      new Set([
        "container_invocation_copy_missing:/app/missing.mjs",
        "unsupported_dynamic_node_invocation",
        "unsupported_compose_healthcheck_test:unsupported_root"
      ])
    );
    assert.equal(
      result.runtimeInvocationLedger?.filter(
        ({ disposition }) => disposition === "unsupported"
      ).length,
      3,
      "every unsupported Node-capable healthcheck root must retain a ledger row"
    );

    const baselineDigest = computeRuntimeInvocationLedgerDigest(
      result.runtimeInvocationLedger ?? []
    );
    writeFixture(
      "compose.healthchecks.yml",
      composeSource.replace(
        'x-probe: &probe ["CMD", "node", "--eval", "process.exit(0)"]',
        'x-probe: &probe ["CMD", "node", "--eval", "process.exit(1)"]'
      )
    );
    const drifted = discoverContainerCommandBindings(temporaryRoot);
    assert.notEqual(
      computeRuntimeInvocationLedgerDigest(drifted.runtimeInvocationLedger ?? []),
      baselineDigest,
      "resolved alias source bytes must bind healthcheck code drift"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("remediation recursively accounts for nested process argv binding patterns", () => {
  const owner = "tools/nested-argv.ts";
  const program = createProgramFromSources(repositoryRoot, {
    [owner]: [
      'const { argv: [, , direct] } = process;',
      'const { ["argv"]: [, , computed = "fallback"] } = process;',
      'const commandIndex = "2";',
      'const { argv: { [commandIndex]: objectCommand } } = process;',
      'const { argv: [, , ...tail] } = process;',
      'let assigned;',
      '({ argv: [, , assigned] } = process);',
      'if (direct === "inspect") void 0;',
      'if (computed === "repair") void 0;',
      'if (objectCommand === "object-form") void 0;',
      'if (assigned === "recover") void 0;',
      'function nestedScope() { const { argv: [, , scoped] } = process; if (scoped === "scoped-form") void 0; }',
      'nestedScope();',
      'const handlers = { restore: () => undefined } as const;',
      'handlers[tail[0]]?.();',
      'declare const dynamicKey: string;',
      'const { [dynamicKey]: [, , hidden] } = process;',
      'if (hidden === "must-not-vanish") void 0;'
    ].join("\n")
  });

  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({ scripts: { nested: "tsx tools/nested-argv.ts" } })
  );
  assert.deepEqual(
    new Set(
      result.observations
        .filter(({ kind }) => kind === "command_variant")
        .map(({ symbol }) => symbol)
    ),
    new Set([
      "inspect",
      "repair",
      "object-form",
      "recover",
      "scoped-form",
      "restore"
    ])
  );
  assert.ok(
    result.diagnostics.some(
      ({ code, file, detail }) =>
        code === "unsupported_package_command_variant" &&
        file === owner &&
        detail === "package_argument_binding_pattern_is_not_static"
    ),
    "a dynamic computed nested argv binding must fail closed"
  );
});

test("remediation fails closed for Compose aliases merges and non-scalar command nodes", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-compose-aliases-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture("Dockerfile", "FROM node:22 AS runner\n");
    writeFixture(
      "compose.alias.yml",
      [
        'x-tool: &tool ["node", "/app/platform-owner.mjs"]',
        "services:",
        "  app:",
        "    entrypoint: *tool"
      ].join("\n") + "\n"
    );
    writeFixture(
      "compose.merge.yml",
      [
        "x-runtime: &runtime",
        '  command: ["node", "/app/platform-owner.mjs"]',
        "services:",
        "  app:",
        "    <<: *runtime"
      ].join("\n") + "\n"
    );
    writeFixture(
      "compose.node.yml",
      "services:\n  app:\n    entrypoint: { executable: node, module: /app/platform-owner.mjs }\n"
    );

    const result = discoverContainerCommandBindings(temporaryRoot);
    for (const file of ["compose.alias.yml", "compose.merge.yml", "compose.node.yml"]) {
      assert.ok(
        result.diagnostics.some(
          ({ code, file: actual }) =>
            code === "unsupported_container_command" && actual === file
        ),
        `${file} command structure must not vanish`
      );
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("remediation accounts for every repository container Node main module extension", () => {
  const packageJsonText = JSON.stringify({
    scripts: {
      build: "npm run build:platform-owner",
      "build:platform-owner":
        "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs"
    }
  });
  const dockerfileText = [
    "FROM node:22 AS runner",
    "WORKDIR /app",
    "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs"
  ].join("\n") + "\n";
  const result = discoverContainerCommandBindings(
    repositoryRoot,
    packageJsonText,
    dockerfileText,
    [
      "exec /usr/local/bin/node /app/rogue.js",
      "exec node /app/rogue.cjs",
      "exec node /app/rogue.ts",
      "exec node /app/platform-owner.mjs"
    ].join("\n") + "\n"
  );

  assert.deepEqual(
    new Set(
      result.diagnostics
        .filter(({ code }) => code === "unsupported_container_command")
        .map(({ detail }) => detail)
    ),
    new Set([
      "container_invocation_copy_missing:/app/rogue.js",
      "container_invocation_copy_missing:/app/rogue.cjs",
      "container_invocation_copy_missing:/app/rogue.ts"
    ])
  );
  assert.ok(
    result.observations.some(
      ({ kind, ownerModule, target }) =>
        kind === "container_invocation" &&
        ownerModule === "scripts/platform-owner.ts" &&
        target === "docker/entrypoint.sh#/app/platform-owner.mjs"
    )
  );
});

test("remediation resolves Server Action namespaces destructuring and assignments", () => {
  const owner = "src/features/namespace-actions-client.tsx";
  const unsupportedOwner = "src/features/namespace-actions-unsupported.tsx";
  const program = createProgramFromSources(repositoryRoot, {
    "src/actions/namespace-actions.ts": [
      '"use server";',
      "export async function createAction() {}",
      "export async function removeAction() {}",
      "export async function updateAction() {}"
    ].join("\n"),
    [owner]: [
      '"use client";',
      'import * as actions from "@/actions/namespace-actions";',
      "const actionAlias = actions;",
      "const { createAction: run } = actionAlias;",
      "let assigned;",
      "({ removeAction: assigned } = actions);",
      "let assignedNamespace;",
      "assignedNamespace = actionAlias;",
      "const { updateAction: update } = assignedNamespace;",
      "export function Client() { run(); assigned(); update(); return null; }"
    ].join("\n"),
    [unsupportedOwner]: [
      '"use client";',
      'import * as actions from "@/actions/namespace-actions";',
      "declare const actionName: string;",
      "const { [actionName]: computed } = actions;",
      "export function Client() { computed(); return null; }"
    ].join("\n")
  });

  const result = discoverClientBindings(program, repositoryRoot, [owner]);
  assert.deepEqual(
    new Set(
      result.observations
        .filter(({ kind }) => kind === "server_action")
        .map(({ target }) => target)
    ),
    new Set([
      "src/actions/namespace-actions.ts#createAction",
      "src/actions/namespace-actions.ts#removeAction",
      "src/actions/namespace-actions.ts#updateAction"
    ])
  );
  assert.deepEqual(result.diagnostics, []);

  const unsupported = discoverClientBindings(
    program,
    repositoryRoot,
    [unsupportedOwner]
  );
  assert.ok(
    unsupported.diagnostics.some(
      ({ code, file, detail }) =>
        code === "unsupported_client_binding" &&
        file === unsupportedOwner &&
        detail === "sensitive_client_reference_is_not_observed:server_action"
    ),
    "a dynamic namespace destructuring key must fail closed"
  );
});

test("remediation scans transitive instrumentation dynamic imports to a fixed point", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-worker-fixed-point-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture("tsconfig.json", JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@/*": ["src/*"] }
      },
      include: ["src/**/*.ts"]
    }));
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture(
      "src/server/services/transitive-job.ts",
      "export async function runTransitiveJob() {}\n"
    );
    writeFixture(
      "src/server/arbitrary-background.ts",
      [
        'import { runTransitiveJob } from "@/server/services/transitive-job";',
        "export function launchArbitraryWorker() {",
        "  const cycle = async () => { await runTransitiveJob(); };",
        "  void cycle();",
        "  setInterval(() => { void cycle(); }, 1000);",
        "}"
      ].join("\n") + "\n"
    );
    writeFixture("src/server/side-effect-background.ts", "export const loaded = true;\n");
    writeFixture(
      "src/register-helpers.ts",
      [
        "export async function registerHelpers() {",
        '  const { launchArbitraryWorker: launch } = await import("./server/arbitrary-background");',
        "  launch();",
        '  await import("./server/side-effect-background");',
        "}"
      ].join("\n") + "\n"
    );
    writeFixture(
      "src/instrumentation.ts",
      'import { registerHelpers } from "./register-helpers"; export function register() { void registerHelpers(); }\n'
    );

    const registry = buildRepositoryRegistry(temporaryRoot);
    assert.ok(
      registry.owners.some(
        ({ ownerKind, ownerModule }) =>
          ownerKind === "worker" && ownerModule === "src/server/arbitrary-background.ts"
      ),
      "a dynamically registered worker with an arbitrary filename must enter owner closure"
    );
    assert.ok(
      registry.owners
        .find(({ ownerModule }) => ownerModule === "src/instrumentation.ts")
        ?.bindings.some(
          ({ kind, target, anchorFile }) =>
            kind === "worker_dynamic_import" &&
            target === "src/server/arbitrary-background.ts#launchArbitraryWorker" &&
            anchorFile === "src/register-helpers.ts"
        )
    );
    assert.ok(
      registry.diagnostics.some(
        ({ code, file }) =>
          code === "unsupported_worker_wiring" && file === "src/register-helpers.ts"
      ),
      "a transitive side-effect dynamic worker import must fail closed"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("remediation rejects dynamic package executable tokens", () => {
  const program = createProgramFromSources(repositoryRoot, {
    "tools/static.ts": "export const staticTool = true;\n"
  });
  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({
      scripts: {
        init: 'node "$INIT_CWD/scripts/operator.ts"',
        quoted: 'tsx "${TOOL_ROOT}/tools/operator.mjs"',
        suffix: 'node "$OPERATOR.ts"'
      }
    })
  );

  assert.deepEqual(
    result.diagnostics
      .filter(({ code }) => code === "unsupported_package_command_owner")
      .map(({ detail }) => detail),
    [
      "dynamic_node_package_command_main:init",
      "dynamic_package_command_executable:quoted",
      "dynamic_node_package_command_main:suffix"
    ]
  );
});

test("remediation rejects dynamic or unparseable shell Node executable tokens", () => {
  const packageJsonText = JSON.stringify({
    scripts: {
      build: "npm run build:platform-owner",
      "build:platform-owner":
        "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs"
    }
  });
  const dockerfileText = [
    "FROM node:22 AS runner",
    "WORKDIR /app",
    "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs"
  ].join("\n") + "\n";
  for (const entrypointText of [
    'exec "${NODE_BIN:-node}" /app/platform-owner.mjs\n',
    "exec $(command -v node) /app/platform-owner.mjs\n"
  ]) {
    const result = discoverContainerCommandBindings(
      repositoryRoot,
      packageJsonText,
      dockerfileText,
      entrypointText
    );
    assert.ok(
      result.diagnostics.some(
        ({ code, file, detail }) =>
          code === "unsupported_container_command" &&
          file === "docker/entrypoint.sh" &&
          detail === "unsupported_dynamic_node_invocation"
      ),
      `${entrypointText.trim()} must fail closed`
    );
  }
});

test("remediation recursively enumerates repository Compose candidates", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-nested-compose-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture("package.json", JSON.stringify({
      scripts: {
        build: "npm run build:platform-owner",
        "build:platform-owner":
          "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs"
      }
    }));
    writeFixture(
      "Dockerfile",
      "FROM node:22 AS runner\nCOPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs\n"
    );
    writeFixture("docker-compose.yml", "services:\n  app:\n    image: cubby\n");
    writeFixture(
      "scripts/backup-recovery-rehearsal.compose.yml",
      'services:\n  app:\n    command: ["node", "/app/platform-owner.mjs"]\n'
    );
    writeFixture(
      "vendor/ignored.compose.yml",
      'services:\n  app:\n    command: ["node", "/app/rogue.mjs"]\n'
    );

    const result = discoverContainerCommandBindings(temporaryRoot);
    assert.ok(
      result.observations.some(
        ({ kind, anchorFile, target }) =>
          kind === "container_invocation" &&
          anchorFile === "scripts/backup-recovery-rehearsal.compose.yml" &&
          target ===
            "scripts/backup-recovery-rehearsal.compose.yml#services.app.command:/app/platform-owner.mjs"
      ),
      "a nested operational Compose command must enter container accounting"
    );
    assert.ok(
      !result.diagnostics.some(({ file }) => file === "vendor/ignored.compose.yml"),
      "vendor Compose candidates remain excluded"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("discovers an explicit cross-class owner fixture independently of the registry", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-owner-fixture-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "preserve",
          baseUrl: ".",
          paths: { "@/*": ["src/*"] }
        },
        include: ["src/**/*.ts", "src/**/*.tsx", "tools/**/*.ts"]
      })
    );
    writeFixture("package.json", JSON.stringify({ scripts: { tool: "tsx tools/command.ts" } }));
    writeFixture("src/app/route.ts", "export function GET() {}\n");
    writeFixture(
      "src/app/page.tsx",
      'import { runScan } from "@/server/services/run"; export default async function Page() { await runScan(); return null; }\n'
    );
    writeFixture(
      "src/features/client.tsx",
      '"use client"; export function Client() { fetch("/api/example"); return null; }\n'
    );
    writeFixture(
      "src/features/action.ts",
      'export async function fixtureAction() { "use server"; }\n'
    );
    writeFixture(
      "src/server/services/run.ts",
      "export async function runScan() {}\n"
    );
    writeFixture(
      "src/server/fixture-scheduler.ts",
      'import { runScan } from "@/server/services/run"; export function startFixtureScheduler() { const tick = async () => { await runScan(); }; void tick(); setInterval(() => { void tick(); }, 1000); }\n'
    );
    writeFixture(
      "src/instrumentation.ts",
      'export async function register() { const [{ startFixtureScheduler }] = await Promise.all([import("@/server/fixture-scheduler")]); startFixtureScheduler(); }\n'
    );
    writeFixture("tools/command.ts", "export const command = true;\n");

    const registry = buildRepositoryRegistry(temporaryRoot);
    assert.deepEqual(
      registry.owners.map(({ id, ownerModule, ownerKind }) => ({ id, ownerModule, ownerKind })),
      [
        { id: "api_route:src/app/route.ts", ownerModule: "src/app/route.ts", ownerKind: "api_route" },
        { id: "server_loader:src/app/page.tsx", ownerModule: "src/app/page.tsx", ownerKind: "server_loader" },
        { id: "client_binding:src/features/client.tsx", ownerModule: "src/features/client.tsx", ownerKind: "client_binding" },
        { id: "server_action:src/features/action.ts", ownerModule: "src/features/action.ts", ownerKind: "server_action" },
        { id: "instrumentation:src/instrumentation.ts", ownerModule: "src/instrumentation.ts", ownerKind: "instrumentation" },
        { id: "worker:src/server/fixture-scheduler.ts", ownerModule: "src/server/fixture-scheduler.ts", ownerKind: "worker" },
        { id: "package_command:tools/command.ts", ownerModule: "tools/command.ts", ownerKind: "package_command" }
      ]
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("final check reports fixed independent omissions as missing sidecars", () => {
  const simulatedOmissions = [
    {
      id: "api_route:src/app/api/fixture/route.ts",
      ownerModule: "src/app/api/fixture/route.ts",
      sidecarPath: "src/app/api/fixture/route.operation.ts",
      reason: "undeclared_owner"
    },
    {
      id: "client_binding:src/features/fixture-client.tsx",
      ownerModule: "src/features/fixture-client.tsx",
      sidecarPath: "src/features/fixture-client.operation.ts",
      reason: "undeclared_owner"
    }
  ];
  const expectedMissingSidecars = [
    "src/app/api/fixture/route.operation.ts",
    "src/features/fixture-client.operation.ts"
  ];

  const actualMissingSidecars = checkRegistryCompletion({
    omissionLedger: simulatedOmissions
  })
    .filter((diagnostic) => diagnostic.code === "missing_sidecar")
    .map((diagnostic) => diagnostic.file)
    .sort();

  assert.deepEqual(actualMissingSidecars, expectedMissingSidecars);
  assert.deepEqual(
    checkRepositoryArtifacts(repositoryRoot).filter(
      (diagnostic) => diagnostic.code === "missing_sidecar"
    ),
    []
  );
});

test("eighth remediation propagates package roots through static aggregate value flow", () => {
  const owner = "tools/aggregate-argv.ts";
  const program = createProgramFromSources(repositoryRoot, {
    [owner]: [
      "const holder = { runtime: process };",
      "const commandBox = [holder.runtime.argv.slice(2)];",
      "const [commands] = commandBox;",
      'const [command = "fallback", ...remaining] = commands;',
      'if (command === "inspect") void 0;',
      "const [nextCommand] = remaining;",
      'if (nextCommand === "repair") void 0;',
      "let assignedHolder;",
      "assignedHolder = { runtime: process };",
      "let assignedCommand;",
      "assignedCommand = assignedHolder.runtime.argv[2];",
      'if (assignedCommand === "recover") void 0;',
      "declare const dynamicKey: string;",
      "const ambiguous = holder[dynamicKey].argv[2];",
      'if (ambiguous === "must-not-vanish") void 0;'
    ].join("\n")
  });

  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({ scripts: { aggregate: "tsx tools/aggregate-argv.ts" } })
  );
  assert.deepEqual(
    new Set(
      result.observations
        .filter(({ kind }) => kind === "command_variant")
        .map(({ symbol }) => symbol)
    ),
    new Set(["inspect", "repair", "recover"])
  );
  assert.ok(
    result.diagnostics.some(
      ({ code, file }) =>
        code === "unsupported_package_command_variant" && file === owner
    ),
    "an ambiguous computed aggregate path must fail closed"
  );
});

test("eighth remediation applies rooted argument kinds to parameter binding patterns", () => {
  const owner = "tools/pattern-dispatch.ts";
  const program = createProgramFromSources(repositoryRoot, {
    [owner]: [
      "function dispatch([command = 'fallback', ...remaining]: readonly string[]) {",
      '  if (command === "inspect") void 0;',
      "  const [nextCommand] = remaining;",
      '  if (nextCommand === "repair") void 0;',
      "}",
      "const execute = dispatch;",
      "execute(process.argv.slice(2));",
      "function dispatchObject({ 0: command }: Record<number, string>) {",
      '  if (command === "recover") void 0;',
      "}",
      "dispatchObject(process.argv.slice(2));",
      "declare const dynamicKey: string;",
      "function ambiguous({ [dynamicKey]: command }: Record<string, string>) {",
      '  if (command === "must-not-vanish") void 0;',
      "}",
      "ambiguous(process.argv.slice(2));"
    ].join("\n")
  });

  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({ scripts: { patterns: "tsx tools/pattern-dispatch.ts" } })
  );
  assert.deepEqual(
    new Set(
      result.observations
        .filter(({ kind }) => kind === "command_variant")
        .map(({ symbol }) => symbol)
    ),
    new Set(["inspect", "repair", "recover"])
  );
  assert.ok(
    result.diagnostics.some(
      ({ code, file, detail }) =>
        code === "unsupported_package_command_variant" &&
        file === owner &&
        detail === "package_argument_binding_pattern_is_not_static"
    ),
    "a dynamic computed parameter binding must fail closed"
  );
});

test("eighth remediation propagates client global roots through aggregates and assignments", () => {
  const owner = "src/features/global-root-flow.tsx";
  const program = createProgramFromSources(repositoryRoot, {
    [owner]: [
      '"use client";',
      "const runtime = globalThis;",
      "const { fetch: request } = runtime;",
      "const holder = { runtime: window };",
      "const nestedRequest = holder.runtime.fetch;",
      "let assignedRuntime;",
      "assignedRuntime = globalThis;",
      "const assignedHolder = { runtime: assignedRuntime };",
      "const { fetch: assignedRequest } = assignedHolder.runtime;",
      'request("/api/request");',
      'nestedRequest("/api/nested");',
      'assignedRequest("/api/assigned");',
      "declare const dynamicKey: string;",
      "const ambiguousRuntime = { runtime: globalThis }[dynamicKey];",
      "const { fetch: ambiguousRequest } = ambiguousRuntime;",
      'ambiguousRequest("/api/ambiguous");'
    ].join("\n")
  });

  const result = discoverClientBindings(program, repositoryRoot, [owner]);
  assert.deepEqual(
    new Set(
      result.observations
        .filter(({ kind }) => kind === "global_fetch")
        .map(({ symbol }) => symbol)
    ),
    new Set(["request[1]", "nestedRequest[1]", "assignedRequest[1]"])
  );
  assert.ok(
    result.diagnostics.some(
      ({ code, file }) => code === "unsupported_client_binding" && file === owner
    ),
    "an ambiguous computed global-object path must fail closed"
  );
});

test("eighth remediation resolves the selected copied container shell source", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-shell-provenance-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "package.json",
      JSON.stringify({
        scripts: {
          build: "npm run build:platform-owner",
          "build:platform-owner":
            "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs"
        }
      })
    );
    writeFixture(
      "Dockerfile",
      [
        "FROM node:22 AS runner",
        "WORKDIR /app",
        "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
        "COPY --chmod=755 docker/alternate-entrypoint.sh /usr/local/bin/cubby-entrypoint",
        'ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]'
      ].join("\n") + "\n"
    );
    writeFixture(
      "docker/alternate-entrypoint.sh",
      "#!/bin/sh\nexec node /app/platform-owner.mjs \"$@\"\n"
    );

    const result = discoverContainerCommandBindings(temporaryRoot);
    assert.ok(
      result.observations.some(
        ({ kind, ownerModule, target, anchorFile }) =>
          kind === "container_invocation" &&
          ownerModule === "scripts/platform-owner.ts" &&
          target === "docker/alternate-entrypoint.sh#/app/platform-owner.mjs" &&
          anchorFile === "docker/alternate-entrypoint.sh"
      ),
      "the selected image shell must bind its exact repository source"
    );
    assert.deepEqual(
      result.diagnostics.filter(
        ({ code }) => code === "unsupported_container_command"
      ),
      []
    );

    writeFixture(
      "Dockerfile",
      readFileSync(resolve(temporaryRoot, "Dockerfile"), "utf8").replace(
        'ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]\n',
        ""
      )
    );
    writeFixture(
      "compose.shell.yml",
      'services:\n  app:\n    entrypoint: ["/usr/local/bin/cubby-entrypoint"]\n'
    );
    const composeSelected = discoverContainerCommandBindings(temporaryRoot);
    assert.ok(
      composeSelected.observations.some(
        ({ kind, anchorFile }) =>
          kind === "container_invocation" &&
          anchorFile === "docker/alternate-entrypoint.sh"
      ),
      "a Compose-selected image shell must resolve through the Docker copy map"
    );
    unlinkSync(resolve(temporaryRoot, "compose.shell.yml"));

    writeFixture(
      "Dockerfile",
      [
        "FROM node:22 AS runner",
        "WORKDIR /app",
        "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
        'ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]'
      ].join("\n") + "\n"
    );
    const missing = discoverContainerCommandBindings(temporaryRoot);
    assert.ok(
      missing.diagnostics.some(
        ({ code, file, detail }) =>
          code === "unsupported_container_command" &&
          file === "Dockerfile" &&
          detail ===
            "container_shell_source_mapping_missing:/usr/local/bin/cubby-entrypoint"
      ),
      "a selected shell without closed repository provenance must fail closed"
    );

    writeFixture(
      "Dockerfile",
      [
        "FROM node:22 AS runner",
        "COPY docker/alternate-entrypoint.sh /usr/local/bin/cubby-entrypoint",
        "ADD docker/second-entrypoint.sh /usr/local/bin/cubby-entrypoint",
        'ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]'
      ].join("\n") + "\n"
    );
    writeFixture(
      "docker/second-entrypoint.sh",
      "#!/bin/sh\nexec node /app/platform-owner.mjs\n"
    );
    const ambiguous = discoverContainerCommandBindings(temporaryRoot);
    assert.ok(
      ambiguous.diagnostics.some(
        ({ code, detail }) =>
          code === "unsupported_container_command" &&
          detail ===
            "container_shell_source_mapping_ambiguous:/usr/local/bin/cubby-entrypoint"
      )
    );

    writeFixture(
      "Dockerfile",
      [
        "FROM node:22 AS runner",
        "COPY docker/missing-entrypoint.sh /usr/local/bin/cubby-entrypoint",
        'ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]'
      ].join("\n") + "\n"
    );
    const uninspectable = discoverContainerCommandBindings(temporaryRoot);
    assert.ok(
      uninspectable.diagnostics.some(
        ({ code, detail }) =>
          code === "unsupported_container_command" &&
          detail === "container_shell_source_uninspectable:docker/missing-entrypoint.sh"
      )
    );

    writeFixture(
      "Dockerfile",
      'FROM node:22 AS runner\nENTRYPOINT ["${CUBBY_ENTRYPOINT}"]\n'
    );
    const dynamic = discoverContainerCommandBindings(temporaryRoot);
    assert.ok(
      dynamic.diagnostics.some(
        ({ code, detail }) =>
          code === "unsupported_container_command" &&
          detail === "container_shell_executable_is_dynamic"
      )
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("ninth remediation propagates process itself through transitive aggregate parameters", () => {
  const owner = "tools/process-parameter-dispatch.ts";
  const program = createProgramFromSources(repositoryRoot, {
    [owner]: [
      "function dispatch({ argv: [, , command = 'fallback'] }: typeof process) {",
      '  if (command === "inspect") void 0;',
      "}",
      "function relay({ runtime, ...rest }: { runtime: typeof process }) {",
      "  const payload = { ...rest, runtime };",
      "  const alias = dispatch;",
      "  alias(payload.runtime);",
      "}",
      "function send(payload: { runtime: typeof process }) {",
      "  relay({ ...payload });",
      "}",
      "send({ runtime: process });"
    ].join("\n")
  });

  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({ scripts: { inspect: "tsx tools/process-parameter-dispatch.ts" } })
  );
  assert.ok(
    result.observations.some(
      ({ kind, symbol }) => kind === "command_variant" && symbol === "inspect"
    ),
    "dispatch(process) must bind a recursively destructured argv discriminator"
  );
  assert.deepEqual(
    result.diagnostics.filter(({ code }) => code === "unsupported_package_command_variant"),
    []
  );
});

test("ninth remediation propagates fetch through local shorthand spread and rest parameters", () => {
  const owner = "src/features/parameter-fetch.tsx";
  const program = createProgramFromSources(repositoryRoot, {
    [owner]: [
      '"use client";',
      "function consume({ fetch: request, ...rest }: { fetch: typeof fetch }) {",
      "  const holder = { ...rest, request };",
      "  forward({ ...holder });",
      "}",
      "function forward({ request }: { request: typeof fetch }) {",
      '  request("/api/transitive");',
      "}",
      "const send = consume;",
      "send({ fetch });"
    ].join("\n")
  });

  const result = discoverClientBindings(program, repositoryRoot, [owner]);
  assert.deepEqual(
    result.observations.map(({ kind, target }) => ({ kind, target })),
    [{ kind: "global_fetch", target: "globalThis.fetch" }]
  );
  assert.deepEqual(result.diagnostics, []);
});

test("ninth remediation propagates Better Auth clients through transitive aggregate parameters", () => {
  const authModule = "src/lib/auth/parameter-client.ts";
  const owner = "src/features/parameter-auth-client.tsx";
  const program = createProgramFromSources(repositoryRoot, {
    [authModule]: [
      'import { createAuthClient } from "better-auth/react";',
      "export const authClient = createAuthClient();"
    ].join("\n"),
    [owner]: [
      '"use client";',
      'import { authClient } from "@/lib/auth/parameter-client";',
      "function send({ authClient: client }: { authClient: typeof authClient }) {",
      "  const payload = { client };",
      "  relay({ ...payload });",
      "}",
      "function relay({ client }: { client: typeof authClient }) {",
      "  const { signOut: endSession } = client;",
      "  endSession();",
      "}",
      "send({ authClient });"
    ].join("\n")
  });

  const result = discoverClientBindings(program, repositoryRoot, [owner]);
  assert.deepEqual(
    result.observations.map(({ kind, target }) => ({ kind, target })),
    [{
      kind: "auth_client_call",
      target: "better-auth/react#createAuthClient.signOut"
    }]
  );
  assert.deepEqual(result.diagnostics, []);
});

test("ninth remediation propagates Server Actions and namespaces through aggregate parameters", () => {
  const actionModule = "src/actions/parameter-actions.ts";
  const owner = "src/features/parameter-actions-client.tsx";
  const program = createProgramFromSources(repositoryRoot, {
    [actionModule]: [
      '"use server";',
      "export async function createAction() {}",
      "export async function saveAction() {}"
    ].join("\n"),
    [owner]: [
      '"use client";',
      'import * as actions from "@/actions/parameter-actions";',
      'import { saveAction } from "@/actions/parameter-actions";',
      "function consume({ actions: actionNamespace, saveAction: save }: { actions: typeof actions; saveAction: typeof saveAction }) {",
      "  const bag = { actions: actionNamespace, saveAction: save };",
      "  const { createAction: run } = bag.actions;",
      "  run();",
      "  relay({ ...bag });",
      "}",
      "function relay({ saveAction: execute }: { saveAction: typeof saveAction }) {",
      "  execute();",
      "}",
      "consume({ actions, saveAction });"
    ].join("\n")
  });

  const result = discoverClientBindings(program, repositoryRoot, [owner]);
  assert.deepEqual(
    new Set(
      result.observations
        .filter(({ kind }) => kind === "server_action")
        .map(({ target }) => target)
    ),
    new Set([
      `${actionModule}#createAction`,
      `${actionModule}#saveAction`
    ])
  );
  assert.deepEqual(result.diagnostics, []);
});

test("ninth remediation rejects every unconsumed or ambiguous parameter-sensitive root", () => {
  const owner = "src/features/ambiguous-parameter-client.tsx";
  const program = createProgramFromSources(repositoryRoot, {
    [owner]: [
      '"use client";',
      "declare const key: string;",
      "function ignore(_payload: unknown) {}",
      "ignore({ fetch });",
      "const bag = { fetch };",
      "function consume(payload: typeof bag) {",
      '  payload[key]("/api/ambiguous");',
      "}",
      "consume({ ...bag });"
    ].join("\n")
  });

  const result = discoverClientBindings(program, repositoryRoot, [owner]);
  assert.equal(result.observations.length, 0);
  assert.ok(
    result.diagnostics.some(({ code }) => code === "unsupported_client_binding")
  );
});

test("ninth remediation never discards a dynamic Node package main or code loader", () => {
  const program = createProgramFromSources(repositoryRoot, {});
  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({
      scripts: {
        "dynamic-main": 'node "$TOOL"',
        "dynamic-substitution": "node $(resolve-tool)",
        "dynamic-loader": 'node --require "$LOADER" scripts/known-owner.ts'
      }
    })
  );
  assert.deepEqual(
    new Set(
      result.diagnostics
        .filter(({ code }) => code === "unsupported_package_command_owner")
        .map(({ detail }) => detail)
    ),
    new Set([
      "dynamic_node_package_command_main:dynamic-main",
      "dynamic_node_package_command_main:dynamic-substitution",
      "dynamic_node_package_command_loader:dynamic-loader"
    ])
  );
});

test("twelfth remediation closes the repository runtime invocation ledger", () => {
  const result = discoverContainerCommandBindings(repositoryRoot);
  assert.deepEqual(
    result.runtimeInvocationLedger?.map((entry) => ({
      path: entry.path,
      codeOption: entry.codeOption,
      disposition: entry.disposition,
      category: entry.exclusion?.category,
      anchorFile: entry.anchorFile
    })),
    [
      {
        path: "/app/node_modules/prisma/build/index.js",
        codeOption: null,
        disposition: "structural_exclusion",
        category: "third_party_migration_cli",
        anchorFile: "docker/entrypoint.sh"
      },
      {
        path: "/app/server.js",
        codeOption: null,
        disposition: "structural_exclusion",
        category: "application_server_runtime",
        anchorFile: "docker/entrypoint.sh"
      },
      {
        path: null,
        codeOption: "-e",
        disposition: "structural_exclusion",
        category: "healthcheck_probe_runtime",
        anchorFile: "docker-compose.yml"
      },
      {
        path: null,
        codeOption: "-e",
        disposition: "structural_exclusion",
        category: "healthcheck_probe_runtime",
        anchorFile: "scripts/backup-recovery-rehearsal.compose.yml"
      }
    ]
  );
  assert.ok(
    result.runtimeInvocationLedger?.every(
      ({ anchorFile, anchorStart, anchorEnd, anchorBytes }) =>
        anchorFile.length > 0 &&
        anchorStart >= 0 &&
        anchorEnd > anchorStart &&
        anchorBytes.length === anchorEnd - anchorStart
    )
  );
  assert.deepEqual(
    result.diagnostics.filter(({ code }) => code === "unsupported_container_command"),
    []
  );
});

test("ninth remediation binds exact selected-shell bytes into runtime digests and fingerprints", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-runtime-ledger-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture("package.json", JSON.stringify({ scripts: {} }));
    writeFixture(
      "Dockerfile",
      [
        "FROM node:22 AS runner",
        "COPY docker/entrypoint.sh /usr/local/bin/cubby-entrypoint",
        'ENTRYPOINT ["/usr/local/bin/cubby-entrypoint"]'
      ].join("\n") + "\n"
    );
    const baselineShell = [
      "#!/bin/sh",
      "if ! node node_modules/prisma/build/index.js migrate deploy >/dev/null 2>&1; then",
      "  exit 1",
      "fi",
      "exec node server.js"
    ].join("\n") + "\n";
    writeFixture("docker/entrypoint.sh", baselineShell);
    const baseline = discoverContainerCommandBindings(temporaryRoot);
    const baselineDigest = computeRuntimeInvocationLedgerDigest(
      baseline.runtimeInvocationLedger ?? []
    );
    const baselineFingerprints = baseline.runtimeInvocationLedger?.map(
      ({ fingerprint }) => fingerprint
    );

    writeFixture(
      "docker/entrypoint.sh",
      baselineShell.replace("migrate deploy", "migrate status")
    );
    const migrationDrift = discoverContainerCommandBindings(temporaryRoot);
    assert.notEqual(
      computeRuntimeInvocationLedgerDigest(migrationDrift.runtimeInvocationLedger ?? []),
      baselineDigest
    );
    assert.notDeepEqual(
      migrationDrift.runtimeInvocationLedger?.map(({ fingerprint }) => fingerprint),
      baselineFingerprints
    );
    assert.ok(
      migrationDrift.diagnostics.some(
        ({ code, detail }) =>
          code === "unsupported_container_command" &&
          detail === "container_invocation_copy_missing:/app/node_modules/prisma/build/index.js"
      )
    );

    writeFixture(
      "docker/entrypoint.sh",
      baselineShell.replace("exec node server.js", "exec node server.js --inspect")
    );
    const serverDrift = discoverContainerCommandBindings(temporaryRoot);
    assert.notEqual(
      computeRuntimeInvocationLedgerDigest(serverDrift.runtimeInvocationLedger ?? []),
      baselineDigest
    );
    assert.notDeepEqual(
      serverDrift.runtimeInvocationLedger?.map(({ fingerprint }) => fingerprint),
      baselineFingerprints
    );
    assert.ok(
      serverDrift.diagnostics.some(
        ({ code, detail }) =>
          code === "unsupported_container_command" &&
          detail === "container_invocation_copy_missing:/app/server.js"
      )
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("tenth remediation rejects package argv roots stored in class fields or reached through this", () => {
  const owner = "tools/class-process-dispatch.ts";
  const program = createProgramFromSources(repositoryRoot, {
    [owner]: [
      "class Runtime {",
      "  runtime = process;",
      "  run() {",
      "    const command = this.runtime.argv[2];",
      '    if (command === "inspect") void 0;',
      "  }",
      "}",
      "new Runtime().run();"
    ].join("\n")
  });

  const result = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({ scripts: { tool: "tsx tools/class-process-dispatch.ts" } })
  );
  assert.ok(
    result.diagnostics.some(
      ({ code, file, detail }) =>
        code === "unsupported_package_command_variant" &&
        file === owner &&
        detail === "package_argument_class_field_or_this_flow_is_not_static"
    ),
    "a process root stored in a class instance must never disappear from package argv accounting"
  );
});

test("tenth remediation rejects Node-capable dynamic executables without relying on module suffixes", () => {
  const program = createProgramFromSources(repositoryRoot, {});
  const packageResult = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({
      scripts: {
        defaulted: "${NODE_BIN:-node} worker",
        variable: "'$NODE_BIN' worker",
        absolute: '"/usr/bin/${NODE_BIN:-node}" worker',
        loader: '"$NODE_BIN" --require "$LOADER" worker'
      }
    })
  );
  assert.deepEqual(
    new Set(
      packageResult.diagnostics
        .filter(({ code }) => code === "unsupported_package_command_owner")
        .map(({ detail }) => detail)
    ),
    new Set([
      "dynamic_node_package_command_executable:defaulted",
      "dynamic_node_package_command_executable:variable",
      "dynamic_node_package_command_executable:absolute",
      "dynamic_node_package_command_executable:loader"
    ])
  );

  const dockerShell = discoverContainerCommandBindings(
    repositoryRoot,
    JSON.stringify({ scripts: {} }),
    "FROM node:22 AS runner\nCMD ${NODE_BIN:-node} worker\n",
    ""
  );
  assert.ok(
    dockerShell.diagnostics.some(
      ({ code, file, detail }) =>
        code === "unsupported_container_command" &&
        file === "Dockerfile" &&
        detail === "unsupported_dynamic_node_invocation"
    ),
    "a Docker shell-form dynamic Node executable must fail closed"
  );

  const selectedShell = discoverContainerCommandBindings(
    repositoryRoot,
    JSON.stringify({ scripts: {} }),
    "FROM node:22 AS runner\n",
    'exec "$NODE_BIN" worker\n'
  );
  assert.ok(
    selectedShell.diagnostics.some(
      ({ code, file, detail }) =>
        code === "unsupported_container_command" &&
        file === "docker/entrypoint.sh" &&
        detail === "unsupported_dynamic_node_invocation"
    ),
    "a copied selected shell dynamic Node executable must fail closed"
  );

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-dynamic-node-compose-"));
  try {
    writeFileSync(resolve(temporaryRoot, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(resolve(temporaryRoot, "Dockerfile"), "FROM node:22 AS runner\n");
    writeFileSync(
      resolve(temporaryRoot, "compose.dynamic.yml"),
      "services:\n  worker:\n    command: '\"$NODE_BIN\" worker'\n"
    );
    const composeResult = discoverContainerCommandBindings(temporaryRoot);
    assert.ok(
      composeResult.diagnostics.some(
        ({ code, file, detail }) =>
          code === "unsupported_container_command" &&
          file === "compose.dynamic.yml" &&
          detail === "unsupported_dynamic_node_invocation"
      ),
      "a Compose dynamic Node executable must fail closed"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("eleventh remediation rejects static Node executable basenames with dynamic affixes", () => {
  const program = createProgramFromSources(repositoryRoot, {});
  const packageResult = discoverPackageCommands(
    program,
    repositoryRoot,
    JSON.stringify({
      scripts: {
        typescript: "node${BIN_SUFFIX} tools/operator.ts",
        javascript: '"/usr/bin/node${SUFFIX}" tools/operator.js',
        suffixless: '"node${BIN_SUFFIX}" worker',
        prefixed: "${BIN_PREFIX}node worker",
        arbitrary: "anode${BIN_SUFFIX} tools/operator.ts"
      }
    })
  );
  assert.deepEqual(
    packageResult.diagnostics
      .filter(({ code }) => code === "unsupported_package_command_owner")
      .map(({ detail }) => detail),
    [
      "dynamic_node_package_command_executable:typescript",
      "dynamic_node_package_command_executable:javascript",
      "dynamic_node_package_command_executable:suffixless",
      "dynamic_node_package_command_executable:prefixed"
    ]
  );

  const dockerShell = discoverContainerCommandBindings(
    repositoryRoot,
    JSON.stringify({ scripts: {} }),
    "FROM node:22 AS runner\nCMD node${BIN_SUFFIX} worker\n",
    ""
  );
  assert.ok(
    dockerShell.diagnostics.some(
      ({ code, file, detail }) =>
        code === "unsupported_container_command" &&
        file === "Dockerfile" &&
        detail === "unsupported_dynamic_node_invocation"
    ),
    "a Docker shell-form static Node basename with a dynamic suffix must fail closed"
  );

  const selectedShell = discoverContainerCommandBindings(
    repositoryRoot,
    JSON.stringify({ scripts: {} }),
    "FROM node:22 AS runner\n",
    'exec /usr/bin/node${SUFFIX} tools/operator.js\n'
  );
  assert.ok(
    selectedShell.diagnostics.some(
      ({ code, file, detail }) =>
        code === "unsupported_container_command" &&
        file === "docker/entrypoint.sh" &&
        detail === "unsupported_dynamic_node_invocation"
    ),
    "a selected-shell static Node basename with a dynamic suffix must fail closed"
  );

  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-node-affix-compose-"));
  try {
    writeFileSync(resolve(temporaryRoot, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(resolve(temporaryRoot, "Dockerfile"), "FROM node:22 AS runner\n");
    writeFileSync(
      resolve(temporaryRoot, "compose.dynamic.yml"),
      "services:\n  worker:\n    command: '\"node${BIN_SUFFIX}\" tools/operator.ts'\n"
    );
    const composeResult = discoverContainerCommandBindings(temporaryRoot);
    assert.ok(
      composeResult.diagnostics.some(
        ({ code, file, detail }) =>
          code === "unsupported_container_command" &&
          file === "compose.dynamic.yml" &&
          detail === "unsupported_dynamic_node_invocation"
      ),
      "a Compose static Node basename with a dynamic suffix must fail closed"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("tenth remediation discovers and deduplicates every Compose-selected Dockerfile", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-compose-dockerfiles-"));
  const writeFixture = (file, content) => {
    const target = resolve(temporaryRoot, file);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    writeFixture(
      "package.json",
      JSON.stringify({
        scripts: {
          build: "npm run build:platform-owner",
          "build:platform-owner":
            "esbuild scripts/platform-owner.ts --bundle --outfile=dist/platform-owner.mjs"
        }
      })
    );
    writeFixture("Dockerfile", "FROM node:22 AS runner\n");
    writeFixture(
      "docker/worker.Dockerfile",
      [
        "FROM node:22 AS runner",
        "WORKDIR /app",
        "COPY --from=builder /app/dist/platform-owner.mjs ./platform-owner.mjs",
        'CMD ["node", "/app/platform-owner.mjs"]'
      ].join("\n") + "\n"
    );
    writeFixture(
      "docker-compose.yml",
      [
        "services:",
        "  default:",
        "    build: .",
        "  worker:",
        "    build:",
        "      context: .",
        "      dockerfile: docker/worker.Dockerfile"
      ].join("\n") + "\n"
    );
    writeFixture(
      "deploy/compose.worker.yml",
      [
        "services:",
        "  worker:",
        "    build:",
        "      context: ..",
        "      dockerfile: docker/worker.Dockerfile"
      ].join("\n") + "\n"
    );

    const result = discoverContainerCommandBindings(temporaryRoot);
    assert.equal(
      result.observations.filter(
        ({ kind, anchorFile }) =>
          kind === "container_copy" && anchorFile === "docker/worker.Dockerfile"
      ).length,
      1,
      "the same selected Dockerfile must be inspected once"
    );
    assert.ok(
      result.observations.some(
        ({ kind, ownerModule, anchorFile, target }) =>
          kind === "container_invocation" &&
          ownerModule === "scripts/platform-owner.ts" &&
          anchorFile === "docker/worker.Dockerfile" &&
          target ===
            "docker/worker.Dockerfile#CMD:/app/platform-owner.mjs"
      ),
      "the selected worker Dockerfile CMD must map its copied package owner"
    );
    assert.equal(
      result.structuralIdentityAnchors?.filter(
        ({ kind, targetFile }) =>
          kind === "container_dockerfile" && targetFile === "docker/worker.Dockerfile"
      ).length,
      1
    );
    assert.deepEqual(
      new Set(
        result.structuralIdentityAnchors
          ?.filter(
            ({ kind, targetFile }) =>
              kind === "container_build_selector" &&
              targetFile === "docker/worker.Dockerfile"
          )
          .map(({ file }) => file)
      ),
      new Set(["docker-compose.yml", "deploy/compose.worker.yml"])
    );
    assert.ok(
      result.structuralIdentityAnchors?.some(
        ({ kind, targetFile }) =>
          kind === "container_build_selector" && targetFile === "Dockerfile"
      ),
      "build: . must retain the repository-root Dockerfile default"
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("tenth remediation rejects every unclosed Compose build selector", () => {
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "cubby-compose-build-rejections-"));
  try {
    writeFileSync(resolve(temporaryRoot, "package.json"), JSON.stringify({ scripts: {} }));
    writeFileSync(resolve(temporaryRoot, "Dockerfile"), "FROM node:22 AS runner\n");
    writeFileSync(
      resolve(temporaryRoot, "compose.invalid.yml"),
      [
        "services:",
        "  dynamic:",
        "    build:",
        "      context: .",
        "      dockerfile: ${WORKER_DOCKERFILE}",
        "  missing:",
        "    build:",
        "      context: .",
        "      dockerfile: docker/missing.Dockerfile",
        "  context_escape:",
        "    build:",
        "      context: ../outside",
        "  dockerfile_escape:",
        "    build:",
        "      context: .",
        "      dockerfile: ../outside.Dockerfile",
        "  nonlocal:",
        "    build: https://example.invalid/cubby.git",
        "  ambiguous:",
        "    build:",
        "      context: .",
        "      context: docker",
        "  unsupported:",
        "    build: { context: ., dockerfile: docker/worker.Dockerfile }"
      ].join("\n") + "\n"
    );

    const result = discoverContainerCommandBindings(temporaryRoot);
    assert.deepEqual(
      new Set(
        result.diagnostics
          .filter(({ code, file }) =>
            code === "unsupported_container_command" &&
            file === "compose.invalid.yml"
          )
          .map(({ detail }) => detail)
      ),
      new Set([
        "compose_build_selector_dynamic:dynamic",
        "compose_build_dockerfile_missing:missing:docker/missing.Dockerfile",
        "compose_build_context_escapes_repository:context_escape",
        "compose_build_dockerfile_escapes_repository:dockerfile_escape",
        "compose_build_context_is_nonlocal:nonlocal",
        "compose_build_selector_ambiguous:ambiguous",
        "unsupported_compose_build_selector:unsupported"
      ])
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function snapshotTree(root) {
  const output = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else output[path.slice(root.length + 1).replaceAll("\\", "/")] = readFileSync(path, "utf8");
    }
  };
  visit(root);
  return output;
}

const pattern = process.argv[2] ? new RegExp(process.argv[2], "i") : null;
let failures = 0;
for (const current of tests) {
  if (pattern && !pattern.test(current.name)) continue;
  try {
    await current.run();
    console.log(`PASS ${current.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${current.name}`);
    console.error(error);
  }
}
process.exit(failures > 0 ? 1 : 0);
