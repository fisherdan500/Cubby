import ts from "typescript";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import type {
  DeferredGateDefinition,
  OperationDeclaration,
  OperationOwnerKind,
  RuntimeInvocationLedgerEntry,
  RuntimeInvocationStructuralExclusion,
  StructuralBindingKind
} from "./schema";

type YamlListenerState = {
  readonly position: number;
  readonly kind: "mapping" | "scalar" | "sequence" | null;
  readonly result: unknown;
  readonly anchor: string | null;
};

const yamlLoad = (
  createRequire(import.meta.url)("js-yaml") as {
    readonly load: (
      source: string,
      options?: {
        readonly listener?: (
          event: "open" | "close",
          state: YamlListenerState
        ) => void;
      }
    ) => unknown;
  }
).load;

export type OperationRegistryDiagnosticCode =
  | "unsupported_sidecar_syntax"
  | "invalid_sidecar_schema"
  | "unsupported_route_extension"
  | "unsupported_executable_source"
  | "unresolved_entrypoint"
  | "unsupported_server_action"
  | "unresolved_loader_import"
  | "unsupported_client_binding"
  | "unsupported_worker_wiring"
  | "unresolved_package_command"
  | "unsupported_package_command_owner"
  | "unsupported_package_command_variant"
  | "unsupported_container_command"
  | "stale_structural_exclusion"
  | "generated_artifact_mismatch"
  | "missing_generated_artifact"
  | "unexpected_generated_artifact"
  | "duplicate_generated_id"
  | "stale_generated_row"
  | "missing_sidecar"
  | "fingerprint_mismatch"
  | "unresolved_fingerprint_anchor"
  | "missing_gate"
  | "duplicate_gate"
  | "invalid_gate_registry_shape"
  | "invalid_gate_shape"
  | "orphan_gate"
  | "deferred_gate_promotion"
  | "missing_deferred_gate_reference"
  | "orphan_deferred_gate_reference"
  | "duplicate_deferred_gate_reference"
  | "invented_evidence"
  | "orphan_evidence_gate"
  | "unsupported_evidence_status"
  | "unsupported_evidence_strength"
  | "orphan_evidence_fingerprint"
  | "collapsed_evidence_outcome"
  | "observation_set_mismatch"
  | "duplicate_declaration"
  | "orphan_declaration"
  | "declaration_identity_mismatch"
  | "declaration_binding_mismatch"
  | "declaration_disposition_mismatch"
  | "sidecar_path_mismatch"
  | "extra_sidecar";

export type OperationRegistryDiagnostic = {
  readonly code: OperationRegistryDiagnosticCode;
  readonly file: string;
  readonly detail: string;
};

export type ParsedSidecar = {
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
  readonly declarations: readonly OperationDeclaration[];
};

export type StructuralObservation = {
  readonly kind: string;
  readonly ownerModule: string;
  readonly symbol: string;
  readonly target: string;
  readonly anchorFile: string;
  readonly anchorStart: number;
  readonly anchorEnd: number;
};

export type StructuralIdentityAnchor = {
  readonly kind: "container_build_selector" | "container_dockerfile";
  readonly file: string;
  readonly targetFile: string;
  readonly start: number;
  readonly end: number;
};

export const APPENDIX_A_SIDECAR_PATHS = [
  "src/app/api/activities/[id]/route.operation.ts",
  "src/app/api/activities/route.operation.ts",
  "src/app/api/activities/undo-last/route.operation.ts",
  "src/app/api/auth/[...all]/route.operation.ts",
  "src/app/api/babies/[id]/deactivate/route.operation.ts",
  "src/app/api/babies/[id]/reactivate/route.operation.ts",
  "src/app/api/babies/route.operation.ts",
  "src/app/api/backups/export/route.operation.ts",
  "src/app/api/backups/local/[filename]/route.operation.ts",
  "src/app/api/backups/restore/preview/route.operation.ts",
  "src/app/api/backups/restore/route.operation.ts",
  "src/app/api/backups/route.operation.ts",
  "src/app/api/backups/sprout/import/route.operation.ts",
  "src/app/api/backups/sprout/preview/route.operation.ts",
  "src/app/api/dashboard/warnings/dismiss/route.operation.ts",
  "src/app/api/export/activities.csv/route.operation.ts",
  "src/app/api/export/activities.tsv/route.operation.ts",
  "src/app/api/health/route.operation.ts",
  "src/app/api/hooks/v1/babies/[babyId]/activities/route.operation.ts",
  "src/app/api/hooks/v1/babies/[babyId]/measurements/latest/route.operation.ts",
  "src/app/api/hooks/v1/babies/[babyId]/reference/route.operation.ts",
  "src/app/api/hooks/v1/babies/[babyId]/status/route.operation.ts",
  "src/app/api/hooks/v1/babies/route.operation.ts",
  "src/app/api/households/leave/route.operation.ts",
  "src/app/api/invites/[token]/accept/route.operation.ts",
  "src/app/api/invites/[token]/revoke/route.operation.ts",
  "src/app/api/invites/revoke-all/route.operation.ts",
  "src/app/api/invites/route.operation.ts",
  "src/app/api/members/[id]/restore/route.operation.ts",
  "src/app/api/members/[id]/route.operation.ts",
  "src/app/api/members/[id]/suspend/route.operation.ts",
  "src/app/api/notifications/preferences/route.operation.ts",
  "src/app/api/notifications/subscribe/route.operation.ts",
  "src/app/api/onboarding/route.operation.ts",
  "src/app/api/platform/registration/route.operation.ts",
  "src/app/api/settings/api-keys/[id]/revoke/route.operation.ts",
  "src/app/api/settings/api-keys/route.operation.ts",
  "src/app/api/settings/appearance/route.operation.ts",
  "src/app/api/settings/registration/route.operation.ts",
  "src/app/api/settings/units/route.operation.ts",
  "src/app/api/settings/webhooks/[id]/route.operation.ts",
  "src/app/api/settings/webhooks/route.operation.ts",
  "src/app/api/timers/[id]/pause/route.operation.ts",
  "src/app/api/timers/[id]/resume/route.operation.ts",
  "src/app/api/timers/[id]/stop/route.operation.ts",
  "src/app/app/activities/[id]/edit/page.operation.ts",
  "src/app/app/activities/[id]/page.operation.ts",
  "src/app/app/babies/page.operation.ts",
  "src/app/app/calendar/page.operation.ts",
  "src/app/app/history/page.operation.ts",
  "src/app/app/layout.operation.ts",
  "src/app/app/log/[type]/page.operation.ts",
  "src/app/app/nursery/page.operation.ts",
  "src/app/app/page.operation.ts",
  "src/app/app/reports/page.operation.ts",
  "src/app/app/settings/appearance/page.operation.ts",
  "src/app/app/settings/backups/page.operation.ts",
  "src/app/app/settings/export/page.operation.ts",
  "src/app/app/settings/integrations/page.operation.ts",
  "src/app/app/settings/leave/page.operation.ts",
  "src/app/app/settings/members/page.operation.ts",
  "src/app/app/settings/notifications/page.operation.ts",
  "src/app/app/settings/page.operation.ts",
  "src/app/app/settings/sessions/page.operation.ts",
  "src/app/app/settings/units/page.operation.ts",
  "src/app/invite/[token]/page.operation.ts",
  "src/app/login/page.operation.ts",
  "src/app/onboarding/page.operation.ts",
  "src/app/page.operation.ts",
  "src/app/platform/settings/page.operation.ts",
  "src/app/register/page.operation.ts",
  "src/components/actions/accept-invite-button.operation.ts",
  "src/components/actions/activity-actions.operation.ts",
  "src/components/actions/baby-lifecycle-button.operation.ts",
  "src/components/actions/confirmed-activity-delete.operation.ts",
  "src/components/auth/auth-form.operation.ts",
  "src/components/dashboard/dashboard-warnings.operation.ts",
  "src/components/forms/activity-form.operation.ts",
  "src/components/forms/baby-form.operation.ts",
  "src/components/forms/invite-form.operation.ts",
  "src/components/forms/onboarding-form.operation.ts",
  "src/components/settings/appearance-form.operation.ts",
  "src/components/settings/backup-download-button.operation.ts",
  "src/components/settings/backup-restore-form.operation.ts",
  "src/components/settings/integration-forms.operation.ts",
  "src/components/settings/leave-household-form.operation.ts",
  "src/components/settings/member-access-manager.operation.ts",
  "src/components/settings/notification-preference-form.operation.ts",
  "src/components/settings/registration-settings-form.operation.ts",
  "src/components/settings/session-manager.operation.ts",
  "src/components/settings/sprout-restore-form.operation.ts",
  "src/components/settings/unit-preferences-form.operation.ts",
  "src/components/sign-out-button.operation.ts",
  "src/app/app/calendar/actions.operation.ts",
  "src/instrumentation.operation.ts",
  "src/server/automated-backup-scheduler.operation.ts",
  "src/server/integrity-scheduler.operation.ts",
  "src/server/sprout-source-retention-scheduler.operation.ts",
  "scripts/activity-update-safety-rehearsal.operation.ts",
  "scripts/backup-recovery-rehearsal.operation.ts",
  "scripts/integrity-check.operation.ts",
  "scripts/platform-owner.operation.ts",
  "scripts/sprout-preview-commit.acceptance-rehearsal.operation.ts",
  "scripts/update-preflight.operation.ts",
  "prisma/seed.operation.ts"
] as const;

export type StructuralDiscovery = {
  readonly observations: readonly StructuralObservation[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
  readonly runtimeInvocationLedger?: readonly RuntimeInvocationLedgerEntry[];
  readonly structuralIdentityAnchors?: readonly StructuralIdentityAnchor[];
};

export type StructuralExclusion = {
  readonly ownerModule: string;
  readonly category: "rehearsal" | "fixture" | "build_tool" | "registry_tooling";
  readonly rationale: string;
  readonly packageScripts: readonly string[];
};

export type StructuralExclusionDiscovery = {
  readonly exclusions: readonly StructuralExclusion[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
};

export type NormalizedOwner = {
  readonly id: string;
  readonly ownerModule: string;
  readonly ownerKind: OperationOwnerKind;
  readonly sidecarPath: string;
  readonly disposition: "observed" | "excluded";
  readonly exclusion: StructuralExclusion | null;
  readonly bindings: readonly StructuralObservation[];
};

export type NormalizedDeclaration = {
  readonly sidecarPath: string;
  readonly declaration: OperationDeclaration;
};

export type RepositoryRegistry = {
  readonly schemaVersion: 1;
  readonly generatorVersion: "r0.1";
  readonly authority: "observation_only";
  readonly owners: readonly NormalizedOwner[];
  readonly declarations: readonly NormalizedDeclaration[];
  readonly exclusions: readonly StructuralExclusion[];
  readonly runtimeInvocationLedger: readonly RuntimeInvocationLedgerEntry[];
  readonly structuralIdentityAnchors: readonly StructuralIdentityAnchor[];
  readonly omissionLedger: readonly {
    readonly id: string;
    readonly ownerModule: string;
    readonly sidecarPath: string;
    readonly reason: "undeclared_owner";
  }[];
  readonly unresolvedLedger: readonly OperationRegistryDiagnostic[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
};

export function loadRepositoryProgram(
  repositoryRoot: string,
  relativeRootNames?: readonly string[]
): ts.Program {
  const configPath = ts.findConfigFile(repositoryRoot, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("operation_registry_tsconfig_missing");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error("operation_registry_tsconfig_invalid");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repositoryRoot);
  const rootNames = relativeRootNames
    ? relativeRootNames.map((file) => resolve(repositoryRoot, file))
    : parsed.fileNames;
  return ts.createProgram({ rootNames, options: parsed.options });
}

export function createProgramFromSources(
  repositoryRoot: string,
  sources: Readonly<Record<string, string>>
): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    baseUrl: repositoryRoot,
    paths: { "@/*": ["src/*"] },
    jsx: ts.JsxEmit.Preserve
  };
  const normalized = new Map(
    Object.entries(sources).map(([file, text]) => [resolve(repositoryRoot, file), text])
  );
  const host = ts.createCompilerHost(options, true);
  const defaultFileExists = host.fileExists.bind(host);
  const defaultReadFile = host.readFile.bind(host);
  const defaultDirectoryExists = host.directoryExists?.bind(host);
  const virtualDirectories = new Set<string>();
  for (const fileName of normalized.keys()) {
    let current = dirname(fileName);
    while (!virtualDirectories.has(current)) {
      virtualDirectories.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  host.fileExists = (fileName) => normalized.has(resolve(fileName)) || defaultFileExists(fileName);
  host.readFile = (fileName) => normalized.get(resolve(fileName)) ?? defaultReadFile(fileName);
  host.directoryExists = (directoryName) =>
    virtualDirectories.has(resolve(directoryName)) ||
    Boolean(defaultDirectoryExists?.(directoryName));
  host.getSourceFile = (fileName, languageVersion) => {
    const text = host.readFile(fileName);
    return text === undefined
      ? undefined
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  return ts.createProgram({ rootNames: [...normalized.keys()], options, host });
}

export function discoverRepositoryRouteModules(
  repositoryRoot: string
): { readonly ownerModules: readonly string[]; readonly diagnostics: readonly OperationRegistryDiagnostic[] } {
  const ownerModules: string[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const routeFiles = [resolve(repositoryRoot, "app"), resolve(repositoryRoot, "src/app")]
    .filter(existsSync)
    .flatMap((appRoot) => ts.sys.readDirectory(appRoot, undefined, undefined, ["**/*"]))
    .map((file) => relativeModule(repositoryRoot, file))
    .filter((file) => /(?:^|\/)route\.[^/.]+$/.test(file))
    .sort();
  for (const file of routeFiles) {
    const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    if (extension === "ts" || extension === "tsx") {
      ownerModules.push(file);
      continue;
    }
    diagnostics.push({
      code: "unsupported_route_extension",
      file,
      detail: `unsupported_next_route_extension:${extension}`
    });
  }
  return { ownerModules, diagnostics };
}

type ExecutableSourceCandidates = {
  readonly loaderModules: readonly string[];
  readonly clientBoundaryModules: readonly string[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
};

const TYPESCRIPT_EXECUTABLE_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts"]);
const REPOSITORY_EXECUTABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs"
] as const;

function discoverRepositoryExecutableSourceCandidates(
  program: ts.Program,
  repositoryRoot: string
): ExecutableSourceCandidates {
  const executableRoots = [resolve(repositoryRoot, "src"), resolve(repositoryRoot, "app")]
    .filter(existsSync);
  if (executableRoots.length === 0) {
    return { loaderModules: [], clientBoundaryModules: [], diagnostics: [] };
  }
  const programModules = new Set(
    program.getSourceFiles().map((sourceFile) => relativeModule(repositoryRoot, sourceFile.fileName))
  );
  const loaderModules: string[] = [];
  const clientBoundaryModules: string[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const files = executableRoots
    .flatMap((sourceRoot) => ts.sys.readDirectory(
      sourceRoot,
      [...REPOSITORY_EXECUTABLE_EXTENSIONS],
      ["**/node_modules/**", "**/.next/**", "**/dist/**"],
      ["**/*"]
    ))
    .map((file) => relativeModule(repositoryRoot, file))
    .filter((file) => !file.endsWith(".d.ts") && !file.endsWith(".operation.ts"))
    .filter((file, index, all) => all.indexOf(file) === index)
    .sort();
  for (const file of files) {
    const extension = executableExtension(file);
    if (!extension) continue;
    const inProgram = programModules.has(file);
    const programSource = inProgram
      ? program.getSourceFile(resolve(repositoryRoot, file))
      : undefined;
    const sourceFile = programSource ?? ts.createSourceFile(
      file,
      readFileSync(resolve(repositoryRoot, file), "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    if (/^(?:src\/app|app)\/(?:.*\/)?(?:page|layout)\.[^/.]+$/.test(file)) {
      if (extension !== "ts" && extension !== "tsx") {
        diagnostics.push({
          code: "unsupported_executable_source",
          file,
          detail: `unsupported_executable_source_extension:server_loader:${extension}`
        });
      } else if (!inProgram) {
        diagnostics.push({
          code: "unsupported_executable_source",
          file,
          detail: "server_loader_not_in_typescript_program"
        });
      } else {
        loaderModules.push(file);
      }
    }

    const sourceClasses = new Set<"client" | "server_action">();
    if (hasDirective(sourceFile.statements, "use client")) sourceClasses.add("client");
    if (
      hasDirective(sourceFile.statements, "use server") ||
      containsInlineUseServerDirective(sourceFile)
    ) {
      sourceClasses.add("server_action");
    }
    for (const sourceClass of sourceClasses) {
      if (!TYPESCRIPT_EXECUTABLE_EXTENSIONS.has(extension)) {
        diagnostics.push({
          code: "unsupported_executable_source",
          file,
          detail: `unsupported_executable_source_extension:${sourceClass}:${extension}`
        });
      } else if (!inProgram) {
        diagnostics.push({
          code: "unsupported_executable_source",
          file,
          detail: `${sourceClass}_source_not_in_typescript_program`
        });
      } else if (sourceClass === "client") {
        clientBoundaryModules.push(file);
      }
    }
  }
  return {
    loaderModules: [...new Set(loaderModules)].sort(),
    clientBoundaryModules: [...new Set(clientBoundaryModules)].sort(),
    diagnostics
  };
}

function executableExtension(file: string): string | null {
  const match = file.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? null;
}

export function discoverRouteBindings(
  program: ts.Program,
  repositoryRoot: string,
  ownerModules: readonly string[]
): StructuralDiscovery {
  const checker = program.getTypeChecker();
  const observations: StructuralObservation[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

  for (const ownerModule of ownerModules) {
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, ownerModule));
    if (!sourceFile) {
      diagnostics.push({
        code: "unresolved_entrypoint",
        file: ownerModule,
        detail: "owner_module_not_in_typescript_program"
      });
      continue;
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      diagnostics.push({
        code: "unresolved_entrypoint",
        file: ownerModule,
        detail: "owner_module_symbol_missing"
      });
      continue;
    }
    const exportsByName = new Map(
      checker.getExportsOfModule(moduleSymbol).map((entry) => [entry.getName(), entry])
    );
    for (const method of methods) {
      const exported = exportsByName.get(method);
      if (!exported) continue;
      const resolved = resolveRouteExport(checker, exported, sourceFile, repositoryRoot, method);
      if (!resolved) {
        diagnostics.push({
          code: "unresolved_entrypoint",
          file: ownerModule,
          detail: `unsupported_route_export:${method}`
        });
        continue;
      }
      const anchor = resolved.declaration;
      const anchorSource = anchor.getSourceFile();
      observations.push({
        kind: "route_method",
        ownerModule,
        symbol: method,
        target: resolved.target,
        anchorFile: relativeModule(repositoryRoot, anchorSource.fileName),
        anchorStart: anchor.getStart(anchorSource),
        anchorEnd: anchor.getEnd()
      });
    }
  }
  return { observations, diagnostics };
}

export function discoverServerActions(
  program: ts.Program,
  repositoryRoot: string,
  ownerModules: readonly string[]
): StructuralDiscovery {
  const checker = program.getTypeChecker();
  const observations: StructuralObservation[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  for (const ownerModule of ownerModules) {
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, ownerModule));
    if (!sourceFile) {
      diagnostics.push({
        code: "unsupported_server_action",
        file: ownerModule,
        detail: "owner_module_not_in_typescript_program"
      });
      continue;
    }
    if (hasUseServerDirective(sourceFile.statements)) {
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) {
        diagnostics.push({
          code: "unsupported_server_action",
          file: ownerModule,
          detail: "module_action_symbol_missing"
        });
      } else {
        for (const exported of checker.getExportsOfModule(moduleSymbol)) {
          const resolved = resolveServerActionExport(checker, exported, repositoryRoot);
          if (!resolved) {
            diagnostics.push({
              code: "unsupported_server_action",
              file: ownerModule,
              detail: `module_action_export_is_not_a_direct_function:${exported.getName()}`
            });
            continue;
          }
          const anchor = resolved.declaration;
          const anchorSource = anchor.getSourceFile();
          observations.push({
            kind: "server_action",
            ownerModule,
            symbol: exported.getName(),
            target: resolved.target,
            anchorFile: relativeModule(repositoryRoot, anchorSource.fileName),
            anchorStart: anchor.getStart(anchorSource),
            anchorEnd: anchor.getEnd()
          });
        }
      }
    }

    const visit = (node: ts.Node) => {
      if (isFunctionLikeWithBlock(node) && hasUseServerDirective(node.body.statements)) {
        const name = actionFunctionName(node);
        if (!name) {
          diagnostics.push({
            code: "unsupported_server_action",
            file: ownerModule,
            detail: "inline_action_has_no_exact_symbol"
          });
        } else {
          observations.push(actionObservation(ownerModule, name, node, sourceFile));
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return { observations, diagnostics };
}

export function discoverServerLoaderBindings(
  program: ts.Program,
  repositoryRoot: string,
  ownerModules: readonly string[]
): StructuralDiscovery {
  const checker = program.getTypeChecker();
  const observations: StructuralObservation[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const closureCache = new Map<string, {
    readonly observations: readonly Omit<StructuralObservation, "ownerModule">[];
    readonly diagnostics: readonly Omit<OperationRegistryDiagnostic, "file">[];
  }>();
  for (const ownerModule of ownerModules) {
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, ownerModule));
    if (!sourceFile) {
      diagnostics.push({
        code: "unresolved_loader_import",
        file: ownerModule,
        detail: "owner_module_not_in_typescript_program"
      });
      continue;
    }
    const dynamicImportOrdinals = new Map<string, number>();
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const addTerminalBinding = (
      currentModule: string,
      currentSource: ts.SourceFile,
      symbol: string,
      target: string,
      anchor: ts.Node
    ) => {
      observations.push({
        kind: "server_value_import",
        ownerModule,
        symbol,
        target,
        anchorFile: currentModule,
        anchorStart: anchor.getStart(currentSource),
        anchorEnd: anchor.getEnd()
      });
    };
    const traverseModule = (
      currentModule: string,
      currentSource: ts.SourceFile,
      symbolOverrides = new Map<string, string>()
    ) => {
      const traversalKey = `${currentModule}\0${[...symbolOverrides]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([target, symbol]) => `${target}=${symbol}`)
        .join("\0")}`;
      if (visited.has(traversalKey) || visiting.has(traversalKey)) return;
      const cacheable = symbolOverrides.size === 0;
      const cached = cacheable ? closureCache.get(currentModule) : undefined;
      if (cached) {
        observations.push(...cached.observations.map((entry) => ({
          ...entry,
          ownerModule
        })));
        diagnostics.push(...cached.diagnostics.map((entry) => ({
          ...entry,
          file: ownerModule
        })));
        visited.add(traversalKey);
        return;
      }
      const observationStart = observations.length;
      const diagnosticStart = diagnostics.length;
      visiting.add(traversalKey);

      const traverseSpecifier = (
        specifier: string,
        anchor: ts.Node,
        edge: "value_import" | "value_reexport",
        nextOverrides = symbolOverrides,
        unresolvedDetails?: readonly string[]
      ): string | null => {
        if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
        const explicitExtension = specifier.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase();
        if (
          explicitExtension &&
          !["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(explicitExtension)
        ) {
          return null;
        }
        const targetModule = resolveModuleSpecifierPath(
          program,
          currentSource,
          repositoryRoot,
          specifier
        );
        if (!targetModule) {
          for (const detail of unresolvedDetails ?? [
            `${edge}_unresolved:${currentModule}:${specifier}`
          ]) {
            diagnostics.push({
              code: "unresolved_loader_import",
              file: ownerModule,
              detail
            });
          }
          return null;
        }
        if (!isServerOrDatabaseTarget(targetModule)) {
          const targetSource = program.getSourceFile(resolve(repositoryRoot, targetModule));
          if (!targetSource) {
            diagnostics.push({
              code: "unresolved_loader_import",
              file: ownerModule,
              detail: `${edge}_target_not_in_typescript_program:${currentModule}:${specifier}`
            });
          } else {
            traverseModule(targetModule, targetSource, nextOverrides);
          }
        }
        return targetModule;
      };

      const visitDynamicImports = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          const argument = node.arguments[0];
          if (
            !argument ||
            (!ts.isStringLiteral(argument) &&
              !ts.isNoSubstitutionTemplateLiteral(argument))
          ) {
            diagnostics.push({
              code: "unresolved_loader_import",
              file: ownerModule,
              detail: currentModule === ownerModule
                ? "dynamic_import_specifier_is_not_static"
                : `dynamic_import_specifier_is_not_static:${currentModule}`
            });
            return;
          }
          const specifier = argument.text;
          if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return;
          const target = resolveModuleSpecifierPath(
            program,
            currentSource,
            repositoryRoot,
            specifier
          );
          if (!target) {
            diagnostics.push({
              code: "unresolved_loader_import",
              file: ownerModule,
                detail: currentModule === ownerModule
                  ? `dynamic_value_import_unresolved:${specifier}`
                  : `dynamic_value_import_unresolved:${currentModule}:${specifier}`
            });
          } else if (isServerOrDatabaseTarget(target)) {
            const ordinal = (dynamicImportOrdinals.get(specifier) ?? 0) + 1;
            dynamicImportOrdinals.set(specifier, ordinal);
            observations.push({
              kind: "server_dynamic_import",
              ownerModule,
              symbol: `import(${JSON.stringify(specifier)})[${ordinal}]`,
              target,
              anchorFile: currentModule,
              anchorStart: node.getStart(currentSource),
              anchorEnd: node.getEnd()
            });
          } else {
            const targetSource = program.getSourceFile(resolve(repositoryRoot, target));
            if (!targetSource) {
              diagnostics.push({
                code: "unresolved_loader_import",
                file: ownerModule,
                detail: `dynamic_value_import_target_not_in_typescript_program:${currentModule}:${specifier}`
              });
            } else {
              traverseModule(target, targetSource, symbolOverrides);
            }
          }
          return;
        }
        ts.forEachChild(node, visitDynamicImports);
      };

      for (const statement of currentSource.statements) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          importDeclarationHasRuntimeValue(statement)
        ) {
          const specifier = statement.moduleSpecifier.text;
          const imports: Array<{ readonly local: ts.Identifier; readonly anchor: ts.Node }> = [];
          if (statement.importClause?.name) {
            imports.push({
              local: statement.importClause.name,
              anchor: statement.importClause.name
            });
          }
          const bindings = statement.importClause?.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) {
            imports.push({ local: bindings.name, anchor: bindings });
          }
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              if (!element.isTypeOnly) imports.push({ local: element.name, anchor: element });
            }
          }
          const nextOverrides = new Map(symbolOverrides);
          for (const imported of imports) {
            const target = resolveImportedTarget(checker, imported.local, repositoryRoot);
            if (target && isServerOrDatabaseTarget(target)) {
              nextOverrides.set(target, imported.local.text);
            }
          }
          const targetModule = traverseSpecifier(
            specifier,
            statement,
            "value_import",
            nextOverrides,
            imports.length > 0 &&
              currentModule === ownerModule &&
              isServerLookingSpecifier(specifier, currentSource, repositoryRoot)
              ? imports.map((imported) => `unresolved_value_import:${imported.local.text}`)
              : undefined
          );
          if (targetModule && isServerOrDatabaseTarget(targetModule)) {
            if (imports.length === 0) {
              addTerminalBinding(
                currentModule,
                currentSource,
                `import ${JSON.stringify(specifier)}`,
                targetModule,
                statement
              );
            }
            for (const imported of imports) {
              const target = resolveImportedTarget(checker, imported.local, repositoryRoot);
              if (!target || !isServerOrDatabaseTarget(target)) {
                diagnostics.push({
                  code: "unresolved_loader_import",
                  file: ownerModule,
                  detail: `unresolved_value_import:${currentModule}:${imported.local.text}`
                });
                continue;
              }
              addTerminalBinding(
                currentModule,
                currentSource,
                symbolOverrides.get(target) ?? imported.local.text,
                target,
                imported.anchor
              );
            }
          }
          visitDynamicImports(statement);
          continue;
        }
        if (
          ts.isExportDeclaration(statement) &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          exportDeclarationHasRuntimeValue(statement)
        ) {
          const specifier = statement.moduleSpecifier.text;
          const bindings = statement.exportClause && ts.isNamedExports(statement.exportClause)
            ? statement.exportClause.elements.filter((element) => !element.isTypeOnly)
            : [];
          const nextOverrides = new Map(symbolOverrides);
          for (const binding of bindings) {
            if (!ts.isIdentifier(binding.name)) continue;
            const target = resolveImportedTarget(checker, binding.name, repositoryRoot);
            if (target && isServerOrDatabaseTarget(target)) {
              nextOverrides.set(
                target,
                symbolOverrides.get(target) ?? binding.name.text
              );
            }
          }
          const targetModule = traverseSpecifier(
            specifier,
            statement,
            "value_reexport",
            nextOverrides
          );
          if (targetModule && isServerOrDatabaseTarget(targetModule)) {
            if (bindings.length === 0) {
              addTerminalBinding(
                currentModule,
                currentSource,
                statement.exportClause && ts.isNamespaceExport(statement.exportClause)
                  ? statement.exportClause.name.text
                  : "export *",
                targetModule,
                statement
              );
            }
            for (const binding of bindings) {
              if (!ts.isIdentifier(binding.name)) {
                diagnostics.push({
                  code: "unresolved_loader_import",
                  file: ownerModule,
                  detail: `unsupported_value_reexport_name:${currentModule}`
                });
                continue;
              }
              const target = resolveImportedTarget(checker, binding.name, repositoryRoot);
              if (!target || !isServerOrDatabaseTarget(target)) {
                diagnostics.push({
                  code: "unresolved_loader_import",
                  file: ownerModule,
                  detail: `unresolved_value_reexport:${currentModule}:${binding.name.text}`
                });
                continue;
              }
              addTerminalBinding(
                currentModule,
                currentSource,
                symbolOverrides.get(target) ?? binding.name.text,
                target,
                binding
              );
            }
          }
          visitDynamicImports(statement);
          continue;
        }
        if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) {
          diagnostics.push({
            code: "unresolved_loader_import",
            file: ownerModule,
            detail: `unsupported_value_import_shape:${currentModule}`
          });
          continue;
        }
        visitDynamicImports(statement);
      }
      visiting.delete(traversalKey);
      visited.add(traversalKey);
      if (cacheable) {
        closureCache.set(currentModule, {
          observations: observations.slice(observationStart).map((entry) => {
            const { ownerModule: _ownerModule, ...cachedEntry } = entry;
            return cachedEntry;
          }),
          diagnostics: diagnostics.slice(diagnosticStart).map((entry) => {
            const { file: _file, ...cachedEntry } = entry;
            return cachedEntry;
          })
        });
      }
    };
    traverseModule(ownerModule, sourceFile);
  }
  return { observations, diagnostics };
}

function isServerOrDatabaseTarget(target: string): boolean {
  const modulePath = target.split("#", 1)[0];
  return (
    modulePath.startsWith("src/server/") ||
    modulePath.startsWith("src/lib/db/") ||
    modulePath === "src/lib/db.ts"
  );
}

function isServerLookingSpecifier(
  specifier: string,
  ownerSource: ts.SourceFile,
  repositoryRoot: string
): boolean {
  if (specifier.startsWith("@/server/") || specifier.startsWith("@/lib/db")) {
    return true;
  }
  if (!specifier.startsWith(".")) return false;
  const resolvedPath = relativeModule(
    repositoryRoot,
    resolve(dirname(ownerSource.fileName), specifier)
  );
  return (
    resolvedPath.startsWith("src/server/") ||
    resolvedPath.startsWith("src/lib/db/") ||
    resolvedPath === "src/lib/db"
  );
}

export function discoverClientBindings(
  program: ts.Program,
  repositoryRoot: string,
  ownerModules: readonly string[]
): StructuralDiscovery {
  const checker = program.getTypeChecker();
  const observations: StructuralObservation[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  for (const ownerModule of ownerModules) {
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, ownerModule));
    if (!sourceFile) {
      diagnostics.push({
        code: "unsupported_client_binding",
        file: ownerModule,
        detail: "owner_module_not_in_typescript_program"
      });
      continue;
    }
    const sensitiveDynamicImports = collectSensitiveDynamicImports(
      checker,
      sourceFile,
      repositoryRoot
    );
    for (const dynamicImport of sensitiveDynamicImports) {
      if (!dynamicImport.unsupportedShape) continue;
      diagnostics.push({
        code: "unsupported_client_binding",
        file: ownerModule,
        detail: "sensitive_dynamic_import_binding_is_unsupported"
      });
    }
    const consumedSensitiveDynamicImports = new Set<ts.CallExpression>();
    const ordinals = new Map<string, number>();
    const nextSymbol = (base: string) => {
      const ordinal = (ordinals.get(base) ?? 0) + 1;
      ordinals.set(base, ordinal);
      return `${base}[${ordinal}]`;
    };
    const add = (
      kind: string,
      symbol: string,
      target: string,
      anchor: ts.Node
    ) => {
      observations.push({
        kind,
        ownerModule,
        symbol,
        target,
        anchorFile: ownerModule,
        anchorStart: anchor.getStart(sourceFile),
        anchorEnd: anchor.getEnd()
      });
    };
    const sensitiveReferences = collectDirectSensitiveClientReferences(
      checker,
      sourceFile,
      repositoryRoot
    );
    const coveredSensitiveReferences = new Set<ts.Node>();
    const coverSensitiveSources = (expression: ts.Expression) => {
      for (const dynamicImport of sensitiveDynamicImports) {
        if (
          expressionDependsOnDynamicImport(
            checker,
            expression,
            dynamicImport.call
          )
        ) {
          consumedSensitiveDynamicImports.add(dynamicImport.call);
        }
      }
      for (const reference of traceSensitiveClientSources(
        checker,
        expression,
        sourceFile,
        repositoryRoot
      )) {
        coveredSensitiveReferences.add(reference.node);
      }
    };

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapParentheses(node.expression);
        const delegatedCallInCallee = containsDelegatedClientBindingCall(
          checker,
          callee,
          sourceFile,
          repositoryRoot
        );
        const fetchBinding = resolveGlobalFetchBinding(checker, callee, sourceFile);
        let directClientBinding = Boolean(fetchBinding);
        if (fetchBinding) {
          coverSensitiveSources(callee);
          add(
            "global_fetch",
            nextSymbol(fetchBinding.symbol),
            "globalThis.fetch",
            node
          );
        } else if (
          !delegatedCallInCallee &&
          looksLikeFetchBinding(checker, callee, sourceFile)
        ) {
          coverSensitiveSources(callee);
          diagnostics.push({
            code: "unsupported_client_binding",
            file: ownerModule,
            detail: "unresolved_or_wrapped_fetch_call"
          });
        } else {
          const authBinding = resolveBetterAuthCallBinding(
            checker,
            callee,
            repositoryRoot
          );
          if (authBinding) {
            directClientBinding = true;
            coverSensitiveSources(callee);
            add(
              "auth_client_call",
              nextSymbol(authBinding.symbol),
              `better-auth/react#createAuthClient.${authBinding.path.join(".")}`,
              node
            );
          } else if (
            !delegatedCallInCallee &&
            containsBetterAuthBinding(checker, callee, repositoryRoot)
          ) {
            coverSensitiveSources(callee);
            diagnostics.push({
              code: "unsupported_client_binding",
              file: ownerModule,
              detail: "computed_destructured_or_wrapped_auth_client_call"
            });
          } else {
            const actionTarget = resolveClientServerActionBinding(
              checker,
              callee,
              repositoryRoot
            );
            if (actionTarget) {
              directClientBinding = true;
              coverSensitiveSources(callee);
              const actionSymbol = staticMemberPath(callee);
              add(
                "server_action",
                nextSymbol(
                  actionSymbol
                    ? [actionSymbol.root.text, ...actionSymbol.parts].join(".")
                    : callee.getText(sourceFile)
                ),
                actionTarget,
                node
              );
            }
            if (
              !actionTarget &&
              !delegatedCallInCallee &&
              containsImportedServerAction(checker, callee, repositoryRoot)
            ) {
              coverSensitiveSources(callee);
              diagnostics.push({
                code: "unsupported_client_binding",
                file: ownerModule,
                detail: "wrapped_server_action_call"
              });
            }
          }
        }
        const localCallee = checker.getResolvedSignature(node)?.declaration;
        const hasInspectableLocalBody = Boolean(
          localCallee &&
          localCallee.getSourceFile() === sourceFile &&
          ((ts.isFunctionDeclaration(localCallee) && localCallee.body) ||
            (ts.isFunctionExpression(localCallee) && localCallee.body) ||
            ts.isArrowFunction(localCallee) ||
            (ts.isMethodDeclaration(localCallee) && localCallee.body))
        );
        if (!directClientBinding && !hasInspectableLocalBody) {
          for (const argument of node.arguments) {
            if (
              isPotentialDelegatedClientBindingArgument(
                checker,
                argument,
                sourceFile,
                repositoryRoot
              )
            ) {
              coverSensitiveSources(argument);
              diagnostics.push({
                code: "unsupported_client_binding",
                file: ownerModule,
                detail: "unproved_higher_order_client_binding"
              });
            }
          }
        }
      }

      if (
        ts.isJsxAttribute(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "action" &&
        isFormAttribute(node)
      ) {
        const expression = node.initializer && ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : undefined;
        if (expression && ts.isIdentifier(expression)) {
          const target = resolveFormActionTarget(
            checker,
            expression,
            repositoryRoot,
            ownerModule,
            sourceFile
          );
          if (target) {
            coverSensitiveSources(expression);
            add("form_action", expression.text, target, node);
          } else {
            coverSensitiveSources(expression);
            diagnostics.push({
              code: "unsupported_client_binding",
              file: ownerModule,
              detail: "unresolved_form_action"
            });
          }
        } else {
          diagnostics.push({
            code: "unsupported_client_binding",
            file: ownerModule,
            detail: "wrapped_or_computed_form_action"
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
    for (const reference of sensitiveReferences) {
      if (coveredSensitiveReferences.has(reference.node)) continue;
      diagnostics.push({
        code: "unsupported_client_binding",
        file: ownerModule,
        detail: `sensitive_client_reference_is_not_observed:${reference.kind}`
      });
    }
    for (const dynamicImport of sensitiveDynamicImports) {
      if (
        !dynamicImport.unsupportedShape &&
        !consumedSensitiveDynamicImports.has(dynamicImport.call)
      ) {
        diagnostics.push({
          code: "unsupported_client_binding",
          file: ownerModule,
          detail: "sensitive_dynamic_import_is_not_consumed"
        });
      }
    }
  }
  return { observations, diagnostics };
}

function discoverClientValueImportClosure(
  program: ts.Program,
  repositoryRoot: string,
  boundaryModules: readonly string[]
): { readonly ownerModules: readonly string[]; readonly diagnostics: readonly OperationRegistryDiagnostic[] } {
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const visited = new Set<string>();
  const clientModules = new Set<string>();
  const queue = [...boundaryModules];
  while (queue.length > 0) {
    const ownerModule = queue.shift()!;
    if (visited.has(ownerModule)) continue;
    visited.add(ownerModule);
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, ownerModule));
    if (!sourceFile) {
      diagnostics.push({
        code: "unsupported_client_binding",
        file: ownerModule,
        detail: "client_value_import_owner_not_in_typescript_program"
      });
      continue;
    }
    if (hasUseServerDirective(sourceFile.statements)) {
      continue;
    }
    clientModules.add(ownerModule);
    for (const statement of sourceFile.statements) {
      let specifier: string | null = null;
      let edge: "import" | "reexport" = "import";
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        importDeclarationHasRuntimeValue(statement)
      ) {
        specifier = statement.moduleSpecifier.text;
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        exportDeclarationHasRuntimeValue(statement)
      ) {
        specifier = statement.moduleSpecifier.text;
        edge = "reexport";
      }
      if (!specifier) continue;
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      const target = resolveModuleSpecifierPath(
        program,
        sourceFile,
        repositoryRoot,
        specifier
      );
      if (!target) {
        diagnostics.push({
          code: "unsupported_client_binding",
          file: ownerModule,
          detail: `client_value_${edge}_unresolved:${specifier}`
        });
        continue;
      }
      const targetSource = program.getSourceFile(resolve(repositoryRoot, target));
      if (targetSource && hasUseServerDirective(targetSource.statements)) continue;
      if (!visited.has(target)) queue.push(target);
    }
    const visitDynamicImports = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        const argument = node.arguments[0];
        if (
          !argument ||
          (!ts.isStringLiteral(argument) &&
            !ts.isNoSubstitutionTemplateLiteral(argument))
        ) {
          diagnostics.push({
            code: "unsupported_client_binding",
            file: ownerModule,
            detail: "client_dynamic_import_specifier_is_not_static"
          });
        } else {
          const specifier = argument.text;
          if (specifier.startsWith(".") || specifier.startsWith("@/")) {
            const target = resolveModuleSpecifierPath(
              program,
              sourceFile,
              repositoryRoot,
              specifier
            );
            if (!target) {
              diagnostics.push({
                code: "unsupported_client_binding",
                file: ownerModule,
                detail: `client_dynamic_import_unresolved:${specifier}`
              });
            } else {
              const targetSource = program.getSourceFile(resolve(repositoryRoot, target));
              if (
                !(targetSource && hasUseServerDirective(targetSource.statements)) &&
                !visited.has(target)
              ) {
                queue.push(target);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visitDynamicImports);
    };
    ts.forEachChild(sourceFile, visitDynamicImports);
  }
  return { ownerModules: [...clientModules].sort(), diagnostics };
}

function importDeclarationHasRuntimeValue(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (!clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
}

function exportDeclarationHasRuntimeValue(statement: ts.ExportDeclaration): boolean {
  if (statement.isTypeOnly) return false;
  if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) return true;
  return statement.exportClause.elements.some((element) => !element.isTypeOnly);
}

export function discoverWorkerWiring(
  program: ts.Program,
  repositoryRoot: string,
  ownerModules: readonly string[]
): StructuralDiscovery {
  const checker = program.getTypeChecker();
  const observations: StructuralObservation[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const instrumentationSource = program.getSourceFile(
    resolve(repositoryRoot, "src/instrumentation.ts")
  );
  const staticWorkerGraph = instrumentationSource
    ? discoverStaticInstrumentationWorkerEntries(
        checker,
        instrumentationSource,
        repositoryRoot
      )
    : { entries: [], diagnostics: [], reachableSources: [] };
  const staticWorkers = staticWorkerGraph.entries;
  const directDynamicWorkerGraph = instrumentationSource
    ? discoverInstrumentationDynamicWorkerGraph(
        checker,
        staticWorkerGraph.reachableSources,
        repositoryRoot
      )
    : { entries: [], diagnostics: [], importCalls: [] };
  const staticWorkerSymbols = new Map<string, Set<string>>();
  for (const entry of [...staticWorkers, ...directDynamicWorkerGraph.entries]) {
    const symbols = staticWorkerSymbols.get(entry.ownerModule) ?? new Set<string>();
    symbols.add(entry.targetSymbol);
    staticWorkerSymbols.set(entry.ownerModule, symbols);
  }
  for (const ownerModule of ownerModules) {
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, ownerModule));
    if (!sourceFile) {
      diagnostics.push({
        code: "unsupported_worker_wiring",
        file: ownerModule,
        detail: "owner_module_not_in_typescript_program"
      });
      continue;
    }

    const dynamicImports = discoverPromiseAllDynamicImports(
      program,
      sourceFile,
      repositoryRoot
    );
    const supportedImportCalls = new Set(dynamicImports.map((entry) => entry.importCall));
    for (const entry of dynamicImports) {
      observations.push({
        kind: "worker_dynamic_import",
        ownerModule,
        symbol: entry.local,
        target: entry.target,
        anchorFile: ownerModule,
        anchorStart: entry.binding.getStart(sourceFile),
        anchorEnd: entry.binding.getEnd()
      });
    }
    for (const entry of dynamicImports) {
      const directCalls: ts.CallExpression[] = [];
      const visitCalls = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === entry.local
        ) {
          directCalls.push(node);
        }
        ts.forEachChild(node, visitCalls);
      };
      ts.forEachChild(sourceFile, visitCalls);
      if (directCalls.length === 1) {
        const call = directCalls[0];
        observations.push({
          kind: "worker_start_call",
          ownerModule,
          symbol: entry.local,
          target: entry.target,
          anchorFile: ownerModule,
          anchorStart: call.getStart(sourceFile),
          anchorEnd: call.getEnd()
        });
      } else {
        diagnostics.push({
          code: "unsupported_worker_wiring",
          file: ownerModule,
          detail: `dynamic_worker_requires_one_direct_call:${entry.local}`
        });
      }
    }

    if (ownerModule === "src/instrumentation.ts") {
      diagnostics.push(
        ...staticWorkerGraph.diagnostics,
        ...directDynamicWorkerGraph.diagnostics
      );
      for (const entry of staticWorkers) {
        observations.push({
          kind: "worker_static_import",
          ownerModule,
          symbol: entry.local,
          target: entry.target,
          anchorFile: relativeModule(repositoryRoot, entry.binding.getSourceFile().fileName),
          anchorStart: entry.binding.getStart(entry.binding.getSourceFile()),
          anchorEnd: entry.binding.getEnd()
        });
        if (entry.call) {
          observations.push({
            kind: "worker_start_call",
            ownerModule,
            symbol: entry.local,
            target: entry.target,
            anchorFile: relativeModule(repositoryRoot, entry.call.getSourceFile().fileName),
            anchorStart: entry.call.getStart(entry.call.getSourceFile()),
            anchorEnd: entry.call.getEnd()
          });
        }
      }
      for (const entry of directDynamicWorkerGraph.entries) {
        observations.push({
          kind: "worker_dynamic_import",
          ownerModule,
          symbol: entry.local,
          target: entry.target,
          anchorFile: relativeModule(repositoryRoot, entry.binding.getSourceFile().fileName),
          anchorStart: entry.binding.getStart(entry.binding.getSourceFile()),
          anchorEnd: entry.binding.getEnd()
        });
        if (entry.call) {
          observations.push({
            kind: "worker_start_call",
            ownerModule,
            symbol: entry.local,
            target: entry.target,
            anchorFile: relativeModule(repositoryRoot, entry.call.getSourceFile().fileName),
            anchorStart: entry.call.getStart(entry.call.getSourceFile()),
            anchorEnd: entry.call.getEnd()
          });
        }
      }
    }

    const inspectImports = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        !supportedImportCalls.has(node) &&
        !directDynamicWorkerGraph.importCalls.includes(node)
      ) {
        diagnostics.push({
          code: "unsupported_worker_wiring",
          file: ownerModule,
          detail: "dynamic_import_shape_is_unsupported"
        });
      }
      ts.forEachChild(node, inspectImports);
    };
    ts.forEachChild(sourceFile, inspectImports);

    const requestedStartSymbols = staticWorkerSymbols.get(ownerModule) ?? new Set<string>();
    const startFunctions = collectExportedWorkerStartFunctions(
      sourceFile,
      requestedStartSymbols
    );
    const resolvedStartSymbols = new Set(startFunctions.map((entry) => entry.name));
    for (const requested of requestedStartSymbols) {
      if (resolvedStartSymbols.has(requested)) continue;
      diagnostics.push({
        code: "unsupported_worker_wiring",
        file: ownerModule,
        detail: `worker_start_function_unresolved:${requested}`
      });
    }
    for (const startFunction of startFunctions) {
      const startName = startFunction.name;
      observations.push({
        kind: "worker_start_call",
        ownerModule,
        symbol: startName,
        target: `${ownerModule}#${startName}`,
        anchorFile: ownerModule,
        anchorStart: startFunction.anchor.getStart(sourceFile),
        anchorEnd: startFunction.anchor.getEnd()
      });
      const interval = findCallExpression(startFunction.body, "setInterval");
      const callback = interval?.arguments[0];
      const scheduledCalls = callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
        ? directIdentifierCalls(callback.body)
        : [];
      const localFunctions = collectLocalBlockFunctions(startFunction.body);
      const tickName = scheduledCalls.length === 1 && localFunctions.has(scheduledCalls[0])
        ? scheduledCalls[0]
        : localFunctions.size === 1
          ? [...localFunctions.keys()][0]
          : null;
      const tickDeclaration = tickName ? localFunctions.get(tickName) : undefined;
      if (
        !tickDeclaration?.initializer ||
        (!ts.isArrowFunction(tickDeclaration.initializer) &&
          !ts.isFunctionExpression(tickDeclaration.initializer)) ||
        !ts.isBlock(tickDeclaration.initializer.body)
      ) {
        diagnostics.push({
          code: "unsupported_worker_wiring",
          file: ownerModule,
          detail: "worker_tick_function_unresolved"
        });
      } else {
        const awaitedTargets: Array<{ target: string; call: ts.CallExpression }> = [];
        const visitTick = (node: ts.Node, awaited = false) => {
          const nowAwaited = awaited || ts.isAwaitExpression(node);
          if (nowAwaited && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const target = resolveImportedTarget(checker, node.expression, repositoryRoot);
            if (target?.includes("/services/")) awaitedTargets.push({ target, call: node });
          }
          ts.forEachChild(node, (child) => visitTick(child, nowAwaited));
        };
        visitTick(tickDeclaration.initializer.body);
        if (awaitedTargets.length !== 1) {
          diagnostics.push({
            code: "unsupported_worker_wiring",
            file: ownerModule,
            detail: "worker_tick_target_unresolved"
          });
        } else {
          const tickTarget = awaitedTargets[0];
          observations.push({
            kind: "worker_tick",
            ownerModule,
            symbol: tickName!,
            target: tickTarget.target,
            anchorFile: ownerModule,
            anchorStart: tickTarget.call.getStart(sourceFile),
            anchorEnd: tickTarget.call.getEnd()
          });
        }
        if (
          !interval ||
          !callback ||
          (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
          scheduledCalls.length !== 1 ||
          scheduledCalls[0] !== tickName
        ) {
          diagnostics.push({
            code: "unsupported_worker_wiring",
            file: ownerModule,
            detail: "worker_schedule_target_unresolved"
          });
        } else {
          observations.push({
            kind: "worker_schedule",
            ownerModule,
            symbol: tickName!,
            target: `${ownerModule}#${tickName}`,
            anchorFile: ownerModule,
            anchorStart: interval.getStart(sourceFile),
            anchorEnd: interval.getEnd()
          });
        }
      }
    }
  }
  return { observations, diagnostics };
}

type StaticInstrumentationWorkerEntry = {
  readonly local: string;
  readonly ownerModule: string;
  readonly targetSymbol: string;
  readonly target: string;
  readonly binding: ts.Node;
  readonly call: ts.CallExpression | null;
};

function discoverStaticInstrumentationWorkerEntries(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  repositoryRoot: string
): {
  readonly entries: readonly StaticInstrumentationWorkerEntry[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
  readonly reachableSources: readonly ts.SourceFile[];
} {
  type ImportedValue = {
    readonly local: string;
    readonly symbol: ts.Symbol | null;
    readonly binding: ts.Node;
    readonly source: ts.SourceFile;
    readonly target: ResolvedCallable | null;
  };
  const imports: ImportedValue[] = [];
  const usedImports = new Set<ts.Node>();
  const entriesByTarget = new Map<string, StaticInstrumentationWorkerEntry>();
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const visitedCallables = new Set<ts.Declaration>();
  const scannedSources = new Set<ts.SourceFile>();

  const scanImports = (currentSource: ts.SourceFile) => {
    if (scannedSources.has(currentSource)) return;
    scannedSources.add(currentSource);
    for (const statement of currentSource.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        (!statement.moduleSpecifier.text.startsWith(".") &&
          !statement.moduleSpecifier.text.startsWith("@/")) ||
        !importDeclarationHasRuntimeValue(statement)
      ) {
        continue;
      }
      const bindings: Array<{ readonly local: string; readonly node: ts.Node; readonly name: ts.Identifier }> = [];
      if (statement.importClause?.name) {
        bindings.push({
          local: statement.importClause.name.text,
          node: statement.importClause.name,
          name: statement.importClause.name
        });
      }
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        bindings.push({ local: named.name.text, node: named, name: named.name });
      }
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (!element.isTypeOnly) {
            bindings.push({ local: element.name.text, node: element, name: element.name });
          }
        }
      }
      if (bindings.length === 0) {
        diagnostics.push({
          code: "unsupported_worker_wiring",
          file: relativeModule(repositoryRoot, currentSource.fileName),
          detail: `instrumentation_side_effect_import_is_unsupported:${statement.moduleSpecifier.text}`
        });
      }
      for (const binding of bindings) {
        const symbol = checker.getSymbolAtLocation(binding.name) ?? null;
        const target = resolveInstrumentationCallable(
          checker,
          binding.name,
          repositoryRoot
        );
        imports.push({
          local: binding.local,
          symbol,
          binding: binding.node,
          source: currentSource,
          target
        });
        if (target && target.ownerModule.startsWith("src/server/")) {
          entriesByTarget.set(`${target.ownerModule}#${target.symbol}`, {
            local: binding.local,
            ownerModule: target.ownerModule,
            targetSymbol: target.symbol,
            target: `${target.ownerModule}#${target.symbol}`,
            binding: binding.node,
            call: null
          });
        }
      }
    }
  };

  const markOriginImport = (
    expression: ts.Expression,
    seen = new Set<ts.Symbol>()
  ) => {
    const current = unwrapStaticExpression(expression);
    const root = memberRootIdentifier(current) ??
      (ts.isIdentifier(current) ? current : null);
    const rootSymbol = root ? checker.getSymbolAtLocation(root) : undefined;
    if (!rootSymbol || seen.has(rootSymbol)) return;
    seen.add(rootSymbol);
    for (const imported of imports) {
      if (imported.symbol === rootSymbol) usedImports.add(imported.binding);
    }
    const declaration = rootSymbol.valueDeclaration ?? rootSymbol.declarations?.[0];
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = resolveStaticVariableValue(checker, declaration);
      if (value.kind === "resolved") markOriginImport(value.expression, seen);
    }
  };

  const visitCallable = (callable: ResolvedCallable) => {
    if (visitedCallables.has(callable.declaration)) return;
    visitedCallables.add(callable.declaration);
    scanImports(callable.declaration.getSourceFile());
    const body = callableBody(callable.declaration);
    if (!body) return;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const target = resolveInstrumentationCallable(
          checker,
          node.expression,
          repositoryRoot
        );
        if (target) {
          markOriginImport(node.expression);
          if (target.ownerModule.startsWith("src/server/")) {
            if (expressionUsesDynamicImportBinding(checker, node.expression)) {
              return;
            }
            const key = `${target.ownerModule}#${target.symbol}`;
            const existing = entriesByTarget.get(key);
            if (existing?.call) {
              diagnostics.push({
                code: "unsupported_worker_wiring",
                file: relativeModule(repositoryRoot, node.getSourceFile().fileName),
                detail: `worker_registration_call_is_ambiguous:${target.symbol}`
              });
            } else {
              entriesByTarget.set(key, {
                local: node.expression.getText(node.getSourceFile()),
                ownerModule: target.ownerModule,
                targetSymbol: target.symbol,
                target: key,
                binding: existing?.binding ?? node.expression,
                call: node
              });
            }
            return;
          }
          if (target.ownerModule.startsWith("src/")) {
            visitCallable(target);
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
  };

  scanImports(sourceFile);
  const registerSymbol = checker.getSymbolAtLocation(sourceFile)
    ? checker.getExportsOfModule(checker.getSymbolAtLocation(sourceFile)!)
        .find((entry) => entry.getName() === "register")
    : undefined;
  const registerTarget = registerSymbol
    ? resolvedCallableFromSymbol(checker, registerSymbol, repositoryRoot)
    : null;
  if (registerTarget) visitCallable(registerTarget);

  for (const imported of imports) {
    if (usedImports.has(imported.binding)) continue;
    diagnostics.push({
      code: "unsupported_worker_wiring",
      file: relativeModule(repositoryRoot, imported.source.fileName),
      detail: `instrumentation_value_reference_is_not_registered:${imported.local}`
    });
  }
  return {
    entries: [...entriesByTarget.values()],
    diagnostics,
    reachableSources: [...scannedSources]
  };
}

type ResolvedCallable = {
  readonly declaration: ts.Declaration;
  readonly ownerModule: string;
  readonly symbol: string;
};

function resolvedCallableFromSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  repositoryRoot: string
): ResolvedCallable | null {
  const aliased = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : resolveDynamicImportBindingSymbol(checker, symbol) ?? symbol;
  const declaration = aliased.valueDeclaration ?? aliased.declarations?.[0];
  if (!declaration || !isStaticWorkerCallableDeclaration(declaration)) return null;
  const ownerModule = relativeModule(repositoryRoot, declaration.getSourceFile().fileName);
  if (ownerModule.startsWith("../") || ownerModule.startsWith("..\\")) return null;
  const declarationName =
    (ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration)) &&
      declaration.name && ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : aliased.getName();
  return { declaration, ownerModule, symbol: declarationName };
}

function resolveInstrumentationCallable(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string,
  seen = new Set<ts.Symbol>()
): ResolvedCallable | null {
  const current = unwrapStaticExpression(expression);
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || seen.has(symbol)) return null;
    seen.add(symbol);
    const direct = resolvedCallableFromSymbol(checker, symbol, repositoryRoot);
    if (direct) return direct;
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = resolveStaticVariableValue(checker, declaration);
      if (value.kind === "resolved") {
        return resolveInstrumentationCallable(
          checker,
          value.expression,
          repositoryRoot,
          seen
        );
      }
    }
    return null;
  }
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    const memberIdentifier = ts.isPropertyAccessExpression(current)
      ? current.name
      : current.argumentExpression && ts.isIdentifier(current.argumentExpression)
        ? current.argumentExpression
        : null;
    const memberSymbol = memberIdentifier
      ? checker.getSymbolAtLocation(memberIdentifier)
      : checker.getSymbolAtLocation(current);
    if (memberSymbol) {
      const direct = resolvedCallableFromSymbol(checker, memberSymbol, repositoryRoot);
      if (direct) return direct;
    }
    const dynamicNamespace = resolveDynamicImportNamespaceCallable(
      checker,
      current,
      repositoryRoot
    );
    if (dynamicNamespace) return dynamicNamespace;
    const memberValue = resolveStaticMemberValue(checker, current);
    if (memberValue.kind === "resolved") {
      return resolveInstrumentationCallable(
        checker,
        memberValue.expression,
        repositoryRoot,
        seen
      );
    }
  }
  return null;
}

function resolveDynamicImportNamespaceCallable(
  checker: ts.TypeChecker,
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  repositoryRoot: string
): ResolvedCallable | null {
  const memberName = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression &&
        (ts.isStringLiteral(expression.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))
      ? expression.argumentExpression.text
      : null;
  if (!memberName) return null;
  let moduleExpression = unwrapStaticExpression(expression.expression);
  if (ts.isIdentifier(moduleExpression)) {
    const symbol = checker.getSymbolAtLocation(moduleExpression);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      return null;
    }
    moduleExpression = unwrapStaticExpression(declaration.initializer);
  }
  if (ts.isAwaitExpression(moduleExpression)) {
    moduleExpression = unwrapStaticExpression(moduleExpression.expression);
  }
  if (
    !ts.isCallExpression(moduleExpression) ||
    moduleExpression.expression.kind !== ts.SyntaxKind.ImportKeyword
  ) {
    return null;
  }
  const argument = moduleExpression.arguments[0];
  const moduleSymbol = argument ? checker.getSymbolAtLocation(argument) : undefined;
  const exported = moduleSymbol
    ? checker.getExportsOfModule(moduleSymbol).find((entry) => entry.getName() === memberName)
    : undefined;
  return exported
    ? resolvedCallableFromSymbol(checker, exported, repositoryRoot)
    : null;
}

function expressionUsesDynamicImportBinding(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  seen = new Set<ts.Symbol>()
): boolean {
  const current = unwrapStaticExpression(expression);
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration && ts.isBindingElement(declaration)) {
      return Boolean(dynamicImportBinding(declaration));
    }
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = resolveStaticVariableValue(checker, declaration);
      return value.kind === "resolved" && expressionUsesDynamicImportBinding(
        checker,
        value.expression,
        seen
      );
    }
    return false;
  }
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    return expressionUsesDynamicImportBinding(
      checker,
      current.expression,
      seen
    );
  }
  if (ts.isAwaitExpression(current)) {
    return expressionUsesDynamicImportBinding(checker, current.expression, seen);
  }
  return Boolean(
    ts.isCallExpression(current) &&
    current.expression.kind === ts.SyntaxKind.ImportKeyword
  );
}

function callableBody(declaration: ts.Declaration): ts.Block | null {
  if (isFunctionLikeWithBlock(declaration)) return declaration.body;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return null;
  const initializer = unwrapStaticExpression(declaration.initializer);
  return (
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
    ts.isBlock(initializer.body)
  )
    ? initializer.body
    : null;
}

function discoverDirectInstrumentationDynamicWorkerEntries(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  repositoryRoot: string
): {
  readonly entries: readonly StaticInstrumentationWorkerEntry[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
  readonly importCalls: readonly ts.CallExpression[];
} {
  const entries: StaticInstrumentationWorkerEntry[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const importCalls: ts.CallExpression[] = [];
  const candidates: Array<StaticInstrumentationWorkerEntry & { readonly importCall: ts.CallExpression }> = [];
  const visitImports = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      let ancestor: ts.Node | undefined = node.parent;
      let inPromiseAllArray = false;
      while (ancestor && ancestor !== sourceFile) {
        if (
          ts.isCallExpression(ancestor) &&
          ts.isPropertyAccessExpression(ancestor.expression) &&
          ancestor.expression.expression.getText(sourceFile) === "Promise" &&
          ancestor.expression.name.text === "all"
        ) {
          inPromiseAllArray = true;
          break;
        }
        ancestor = ancestor.parent;
      }
      if (inPromiseAllArray) return;
      importCalls.push(node);
      const argument = node.arguments[0];
      if (
        !argument ||
        (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))
      ) {
        diagnostics.push({
          code: "unsupported_worker_wiring",
          file: relativeModule(repositoryRoot, sourceFile.fileName),
          detail: "dynamic_import_shape_is_unsupported"
        });
        return;
      }
      let current: ts.Node = node;
      if (ts.isAwaitExpression(current.parent)) current = current.parent;
      while (current.parent && ts.isParenthesizedExpression(current.parent)) {
        current = current.parent;
      }
      const variable = current.parent && ts.isVariableDeclaration(current.parent)
        ? current.parent
        : null;
      if (!variable || !ts.isObjectBindingPattern(variable.name)) {
        diagnostics.push({
          code: "unsupported_worker_wiring",
          file: relativeModule(repositoryRoot, sourceFile.fileName),
          detail: "dynamic_import_shape_is_unsupported"
        });
        return;
      }
      for (const binding of variable.name.elements) {
        if (!ts.isIdentifier(binding.name) || binding.dotDotDotToken) {
          diagnostics.push({
            code: "unsupported_worker_wiring",
            file: relativeModule(repositoryRoot, sourceFile.fileName),
            detail: "dynamic_import_shape_is_unsupported"
          });
          continue;
        }
        const symbol = checker.getSymbolAtLocation(binding.name);
        const targetSymbol = symbol ? resolveDynamicImportBindingSymbol(checker, symbol) : null;
        const target = targetSymbol
          ? resolvedCallableFromSymbol(checker, targetSymbol, repositoryRoot)
          : null;
        if (!target || !target.ownerModule.startsWith("src/server/")) {
          diagnostics.push({
            code: "unsupported_worker_wiring",
            file: relativeModule(repositoryRoot, sourceFile.fileName),
            detail: `dynamic_worker_target_unresolved:${binding.name.text}`
          });
          continue;
        }
        candidates.push({
          local: binding.name.text,
          ownerModule: target.ownerModule,
          targetSymbol: target.symbol,
          target: `${target.ownerModule}#${target.symbol}`,
          binding,
          call: null,
          importCall: node
        });
      }
      return;
    }
    ts.forEachChild(node, visitImports);
  };
  ts.forEachChild(sourceFile, visitImports);

  const calls: ts.CallExpression[] = [];
  const visitCalls = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visitCalls);
  };
  ts.forEachChild(sourceFile, visitCalls);
  for (const candidate of candidates) {
    const matched = calls.filter((call) => {
      const target = resolveInstrumentationCallable(
        checker,
        call.expression,
        repositoryRoot
      );
      return target?.ownerModule === candidate.ownerModule &&
        target.symbol === candidate.targetSymbol;
    });
    if (matched.length !== 1) {
      diagnostics.push({
        code: "unsupported_worker_wiring",
        file: relativeModule(repositoryRoot, sourceFile.fileName),
        detail: `dynamic_worker_requires_one_direct_call:${candidate.local}`
      });
    }
    entries.push({ ...candidate, call: matched[0] ?? null });
  }
  return { entries, diagnostics, importCalls };
}

function discoverInstrumentationDynamicWorkerGraph(
  checker: ts.TypeChecker,
  reachableSources: readonly ts.SourceFile[],
  repositoryRoot: string
): {
  readonly entries: readonly StaticInstrumentationWorkerEntry[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
  readonly importCalls: readonly ts.CallExpression[];
} {
  const entries: StaticInstrumentationWorkerEntry[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const importCalls: ts.CallExpression[] = [];
  for (const sourceFile of reachableSources) {
    const discovery = discoverDirectInstrumentationDynamicWorkerEntries(
      checker,
      sourceFile,
      repositoryRoot
    );
    entries.push(...discovery.entries);
    diagnostics.push(...discovery.diagnostics);
    importCalls.push(...discovery.importCalls);
  }
  return { entries, diagnostics, importCalls };
}

function isStaticWorkerCallableDeclaration(declaration: ts.Declaration): boolean {
  if (isFunctionLikeWithBlock(declaration)) return true;
  if (!ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
  const initializer = unwrapStaticExpression(declaration.initializer);
  return Boolean(
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
    ts.isBlock(initializer.body)
  );
}

function collectExportedWorkerStartFunctions(
  sourceFile: ts.SourceFile,
  requested: ReadonlySet<string>
): readonly { readonly name: string; readonly body: ts.Block; readonly anchor: ts.Node }[] {
  const functions: Array<{ readonly name: string; readonly body: ts.Block; readonly anchor: ts.Node }> = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      (requested.has(statement.name.text) || /^start.+Scheduler$/.test(statement.name.text))
    ) {
      functions.push({ name: statement.name.text, body: statement.body, anchor: statement });
      continue;
    }
    if (!ts.isVariableStatement(statement) || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        !requested.has(declaration.name.text) ||
        !declaration.initializer
      ) {
        continue;
      }
      const initializer = unwrapStaticExpression(declaration.initializer);
      if (
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
        ts.isBlock(initializer.body)
      ) {
        functions.push({
          name: declaration.name.text,
          body: initializer.body,
          anchor: declaration
        });
      }
    }
  }
  return functions;
}

function collectLocalBlockFunctions(
  block: ts.Block
): ReadonlyMap<string, ts.VariableDeclaration> {
  const functions = new Map<string, ts.VariableDeclaration>();
  for (const statement of block.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrapStaticExpression(declaration.initializer);
      if (
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
        ts.isBlock(initializer.body)
      ) {
        functions.set(declaration.name.text, declaration);
      }
    }
  }
  return functions;
}

function directIdentifierCalls(node: ts.Node): readonly string[] {
  const calls: string[] = [];
  const visit = (current: ts.Node) => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
      calls.push(current.expression.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

export function discoverPackageCommands(
  program: ts.Program,
  repositoryRoot: string,
  packageJsonText = readFileSync(resolve(repositoryRoot, "package.json"), "utf8")
): StructuralDiscovery {
  const observations: StructuralObservation[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return {
      observations,
      diagnostics: [
        {
          code: "unresolved_package_command",
          file: "package.json",
          detail: "package_json_parse_failed"
        }
      ]
    };
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
    return {
      observations,
      diagnostics: [
        {
          code: "unresolved_package_command",
          file: "package.json",
          detail: "package_scripts_missing"
        }
      ]
    };
  }
  const ownerOrder: string[] = [];
  const unsupportedOwners = new Set<string>();
  const reportUnsupportedOwner = (ownerModule: string) => {
    if (ownerModule === "scripts/generate-brand-icons.mjs") return;
    const extension = executableExtension(ownerModule);
    if (!extension || !["js", "jsx", "mjs", "cjs"].includes(extension)) return;
    if (unsupportedOwners.has(ownerModule)) return;
    unsupportedOwners.add(ownerModule);
    diagnostics.push({
      code: "unsupported_package_command_owner",
      file: "package.json",
      detail: `unsupported_package_command_extension:${extension}:${ownerModule}`
    });
  };
  for (const [scriptName, command] of Object.entries(parsed.scripts)) {
    if (typeof command !== "string") continue;
    const outputOperandRanges = discoverPackageOutputOperandRanges(command);
    const dynamicNodeToken = dynamicPackageNodeTokenKind(command);
    if (dynamicNodeToken) {
      diagnostics.push({
        code: "unsupported_package_command_owner",
        file: "package.json",
        detail: `dynamic_node_package_command_${dynamicNodeToken}:${scriptName}`
      });
    } else if (
      containsDynamicPackageExecutableToken(command, outputOperandRanges)
    ) {
      diagnostics.push({
        code: "unsupported_package_command_owner",
        file: "package.json",
        detail: `dynamic_package_command_executable:${scriptName}`
      });
    }
    for (const executable of discoverStaticNodeCommandExecutables(command)) {
      const ownerModule = normalizeRepositoryCommandPath(executable.value);
      if (ownerModule) reportUnsupportedOwner(ownerModule);
    }
    for (const ownerModule of discoverExistingPackageExecutableTokens(
      repositoryRoot,
      command,
      outputOperandRanges
    )) {
      reportUnsupportedOwner(ownerModule);
    }
    const seenInScript = new Set<string>();
    for (const commandPath of extractRepositoryLocalCommandPaths(
      command,
      ["ts", "tsx", "mts", "cts"],
      outputOperandRanges
    )) {
      const ownerModule = commandPath.path;
      if (seenInScript.has(ownerModule)) continue;
      seenInScript.add(ownerModule);
      if (ownerModule === "scripts/operation-registry.ts") continue;
      const sourceFile = program.getSourceFile(resolve(repositoryRoot, ownerModule));
      if (!sourceFile) {
        diagnostics.push({
          code: "unresolved_package_command",
          file: "package.json",
          detail: `typescript_command_owner_missing:${ownerModule}`
        });
        continue;
      }
      if (!ownerOrder.includes(ownerModule)) ownerOrder.push(ownerModule);
      const anchorStart = Math.max(0, packageJsonText.indexOf(JSON.stringify(scriptName)));
      observations.push({
        kind: "package_script",
        ownerModule,
        symbol: scriptName,
        target: `package.json#scripts.${scriptName}`,
        anchorFile: "package.json",
        anchorStart,
        anchorEnd: anchorStart + JSON.stringify(scriptName).length
      });
    }
  }
  for (const ownerModule of ownerOrder) {
    const sourceFile = program.getSourceFile(resolve(repositoryRoot, ownerModule));
    if (!sourceFile) continue;
    const variants = discoverCommandVariants(
      program.getTypeChecker(),
      sourceFile,
      ownerModule
    );
    observations.push(...variants.observations);
    diagnostics.push(...variants.diagnostics);
  }
  return { observations, diagnostics };
}

function dynamicPackageNodeTokenKind(
  command: string
): "executable" | "main" | "loader" | null {
  for (const words of tokenizeShellCommands(command)) {
    if (
      words.some(
        (word, index) =>
          isNodeCapableDynamicExecutableWord(word) &&
          words.slice(0, index).every((prefix) => isShellCommandPrefix(prefix))
      )
    ) {
      return "executable";
    }
    const nodeIndex = words.findIndex(
      (word, index) =>
        !word.dynamic &&
        word.closed &&
        isNodeExecutableWord(word.value) &&
        words.slice(0, index).every((prefix) => isShellCommandPrefix(prefix))
    );
    if (nodeIndex < 0) continue;
    const nodeWords = words.slice(nodeIndex + 1);
    for (let index = 0; index < nodeWords.length; index += 1) {
      const word = nodeWords[index];
      const equals = word.value.indexOf("=");
      const option = equals >= 0 ? word.value.slice(0, equals) : word.value;
      if (!isNodeCodeLoadingOption(option)) continue;
      const value = equals >= 0 ? word : nodeWords[index + 1];
      if (!value || value.dynamic || !value.closed) return "loader";
      if (equals < 0) index += 1;
    }
    const parsed = parseNodeExecutable(nodeWords);
    if (parsed.kind === "dynamic") return "main";
    if (parsed.kind === "unsupported_option" && parsed.option === "dynamic") {
      return "main";
    }
  }
  return null;
}

const PACKAGE_COMMAND_OUTPUT_OPTIONS = new Set([
  "--outfile",
  "--outdir",
  "--output",
  "--output-file",
  "-o"
]);

type PackageCommandSourceRange = {
  readonly start: number;
  readonly end: number;
};

function discoverPackageOutputOperandRanges(
  command: string
): readonly PackageCommandSourceRange[] {
  const ranges: PackageCommandSourceRange[] = [];
  for (const words of tokenizeShellCommands(command)) {
    const rootIndex = words.findIndex(
      (word, index) =>
        !isShellCommandPrefix(word) &&
        words.slice(0, index).every((prefix) => isShellCommandPrefix(prefix))
    );
    if (rootIndex < 0) continue;
    const root = words[rootIndex];
    if (
      !root.closed ||
      root.dynamic ||
      root.value.replaceAll("\\", "/").split("/").at(-1) !== "esbuild"
    ) {
      continue;
    }
    for (let index = rootIndex + 1; index < words.length; index += 1) {
      const word = words[index];
      if (PACKAGE_COMMAND_OUTPUT_OPTIONS.has(word.value)) {
        const operand = words[index + 1];
        if (operand) {
          ranges.push({ start: operand.start, end: operand.end });
          index += 1;
        }
        continue;
      }
      if (
        [...PACKAGE_COMMAND_OUTPUT_OPTIONS].some((option) =>
          word.value.startsWith(`${option}=`)
        )
      ) {
        const equals = command.indexOf("=", word.start);
        if (equals >= word.start && equals < word.end) {
          ranges.push({ start: equals + 1, end: word.end });
        }
      }
    }
  }
  return ranges;
}

function isInsidePackageOutputOperand(
  start: number,
  end: number,
  outputOperandRanges: readonly PackageCommandSourceRange[]
): boolean {
  return outputOperandRanges.some(
    (range) => start >= range.start && end <= range.end
  );
}

function containsDynamicPackageExecutableToken(
  command: string,
  outputOperandRanges: readonly PackageCommandSourceRange[]
): boolean {
  for (const words of tokenizeShellCommands(command)) {
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (
        outputOperandRanges.some(
          (range) => range.start >= word.start && range.end <= word.end
        )
      ) {
        continue;
      }
      if (!word.dynamic || !/\.(?:[cm]?[jt]sx?)(?:$|[?#])/i.test(word.value)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function discoverExistingPackageExecutableTokens(
  repositoryRoot: string,
  command: string,
  outputOperandRanges: readonly PackageCommandSourceRange[]
): readonly string[] {
  const output = new Set<string>();
  for (const words of tokenizeShellCommands(command)) {
    for (const word of words) {
      if (
        outputOperandRanges.some(
          (range) => range.start >= word.start && range.end <= word.end
        )
      ) {
        continue;
      }
      if (!word.closed || word.dynamic) continue;
      const ownerModule = normalizeRepositoryCommandPath(word.value);
      const extension = ownerModule ? executableExtension(ownerModule) : null;
      if (
        !ownerModule ||
        !extension ||
        !["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(extension) ||
        !existsSync(resolve(repositoryRoot, ownerModule))
      ) {
        continue;
      }
      output.add(ownerModule);
    }
  }
  return [...output];
}

function normalizeRepositoryCommandPath(path: string): string | null {
  const normalized = path.replace(/^\.\//, "").replaceAll("\\", "/");
  if (
    !normalized.includes("/") ||
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.startsWith("node_modules/")
  ) {
    return null;
  }
  return normalized;
}

function extractRepositoryLocalCommandPaths(
  command: string,
  extensions: readonly string[],
  outputOperandRanges: readonly PackageCommandSourceRange[]
): readonly { readonly path: string; readonly start: number; readonly end: number }[] {
  const output: Array<{ readonly path: string; readonly start: number; readonly end: number }> = [];
  const pattern = /(?:^|[\s"'`=(:,;|&])((?:\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.([A-Za-z0-9]+))(?=$|[\s"'`),;|&])/g;
  for (const match of command.matchAll(pattern)) {
    const extension = match[2]?.toLowerCase();
    if (!extension || !extensions.includes(extension) || match.index === undefined) continue;
    const rawPath = match[1];
    const prefixLength = match[0].length - rawPath.length;
    const start = match.index + prefixLength;
    const end = start + rawPath.length;
    if (isInsidePackageOutputOperand(start, end, outputOperandRanges)) {
      continue;
    }
    const path = rawPath.replace(/^\.\//, "");
    if (
      !path.includes("/") ||
      path.startsWith("../") ||
      path.includes("/../") ||
      path.startsWith("node_modules/")
    ) {
      continue;
    }
    output.push({
      path,
      start,
      end
    });
  }
  return output;
}

type SelectedContainerDockerfile = {
  readonly file: string;
  readonly source: string;
  readonly contextDirectory: string;
  readonly selectorAnchors: readonly StructuralIdentityAnchor[];
};

type ComposeBuildCandidate = {
  readonly file: string;
  readonly service: string;
  readonly context: string;
  readonly dockerfile: string;
  readonly start: number;
  readonly end: number;
};

function discoverSelectedContainerDockerfiles(
  repositoryRoot: string
): {
  readonly dockerfiles: readonly SelectedContainerDockerfile[];
  readonly identityAnchors: readonly StructuralIdentityAnchor[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
} {
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const candidates: ComposeBuildCandidate[] = [];
  for (const file of discoverRepositoryComposeFiles(repositoryRoot)) {
    const parsed = parseComposeBuildCandidates(
      file,
      readFileSync(resolve(repositoryRoot, file), "utf8")
    );
    diagnostics.push(...parsed.diagnostics);
    candidates.push(...parsed.candidates);
  }

  const selected = new Map<
    string,
    {
      source: string;
      contextDirectory: string;
      selectorAnchors: StructuralIdentityAnchor[];
    }
  >();
  const repository = realpathSync(resolve(repositoryRoot));
  const repositoryPath = (target: string): string | null => {
    const path = relative(repository, target).replaceAll("\\", "/");
    return path === ""
      ? "."
      : path === ".." || path.startsWith("../") || isAbsolute(path)
        ? null
        : path;
  };
  for (const candidate of candidates) {
    const contextValue = candidate.context.replaceAll("\\", "/");
    const dockerfileValue = candidate.dockerfile.replaceAll("\\", "/");
    if (/[\$`]/.test(contextValue) || /[\$`]/.test(dockerfileValue)) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: candidate.file,
        detail: `compose_build_selector_dynamic:${candidate.service}`
      });
      continue;
    }
    if (
      /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(contextValue) ||
      /^[^/\s]+@[^/\s]+:/.test(contextValue)
    ) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: candidate.file,
        detail: `compose_build_context_is_nonlocal:${candidate.service}`
      });
      continue;
    }
    if (
      /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(dockerfileValue) ||
      /^[^/\s]+@[^/\s]+:/.test(dockerfileValue)
    ) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: candidate.file,
        detail: `compose_build_dockerfile_is_nonlocal:${candidate.service}`
      });
      continue;
    }
    const composeDirectory = dirname(resolve(repositoryRoot, candidate.file));
    const contextDirectory = resolve(composeDirectory, contextValue);
    const lexicalContextPath = repositoryPath(contextDirectory);
    if (!lexicalContextPath) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: candidate.file,
        detail: `compose_build_context_escapes_repository:${candidate.service}`
      });
      continue;
    }
    let realContextDirectory: string;
    try {
      if (!statSync(contextDirectory).isDirectory()) throw new Error("not_directory");
      realContextDirectory = realpathSync(contextDirectory);
    } catch {
      diagnostics.push({
        code: "unsupported_container_command",
        file: candidate.file,
        detail: `compose_build_context_missing:${candidate.service}:${contextValue}`
      });
      continue;
    }
    if (!repositoryPath(realContextDirectory)) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: candidate.file,
        detail: `compose_build_context_escapes_repository:${candidate.service}`
      });
      continue;
    }
    const dockerfileTarget = resolve(contextDirectory, dockerfileValue);
    const dockerfilePath = repositoryPath(dockerfileTarget);
    if (!dockerfilePath) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: candidate.file,
        detail: `compose_build_dockerfile_escapes_repository:${candidate.service}`
      });
      continue;
    }
    let source: string;
    try {
      if (!statSync(dockerfileTarget).isFile()) throw new Error("not_file");
      if (!repositoryPath(realpathSync(dockerfileTarget))) {
        diagnostics.push({
          code: "unsupported_container_command",
          file: candidate.file,
          detail: `compose_build_dockerfile_escapes_repository:${candidate.service}`
        });
        continue;
      }
      source = readFileSync(dockerfileTarget, "utf8");
    } catch {
      diagnostics.push({
        code: "unsupported_container_command",
        file: candidate.file,
        detail: `compose_build_dockerfile_missing:${candidate.service}:${dockerfileValue}`
      });
      continue;
    }
    const selectorAnchor: StructuralIdentityAnchor = {
      kind: "container_build_selector",
      file: candidate.file,
      targetFile: dockerfilePath,
      start: candidate.start,
      end: candidate.end
    };
    const existing = selected.get(dockerfilePath);
    if (existing) {
      if (existing.contextDirectory !== contextDirectory) {
        diagnostics.push({
          code: "unsupported_container_command",
          file: candidate.file,
          detail: `compose_build_selector_ambiguous:${candidate.service}`
        });
        continue;
      }
      existing.selectorAnchors.push(selectorAnchor);
    } else {
      selected.set(dockerfilePath, {
        source,
        contextDirectory,
        selectorAnchors: [selectorAnchor]
      });
    }
  }

  const rootDockerfile = resolve(repositoryRoot, "Dockerfile");
  if (existsSync(rootDockerfile)) {
    const existing = selected.get("Dockerfile");
    if (!existing) {
      selected.set("Dockerfile", {
        source: readFileSync(rootDockerfile, "utf8"),
        contextDirectory: repository,
        selectorAnchors: []
      });
    }
  }
  const dockerfiles = [...selected]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, entry]) => ({ file, ...entry }));
  const identityAnchors = dockerfiles.flatMap((dockerfile) => [
    {
      kind: "container_dockerfile" as const,
      file: dockerfile.file,
      targetFile: dockerfile.file,
      start: 0,
      end: dockerfile.source.length
    },
    ...dockerfile.selectorAnchors
  ]);
  return { dockerfiles, identityAnchors, diagnostics };
}

function parseComposeBuildCandidates(
  file: string,
  source: string
): {
  readonly candidates: readonly ComposeBuildCandidate[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
} {
  const candidates: ComposeBuildCandidate[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const lines = [...source.matchAll(/.*(?:\r?\n|$)/g)]
    .map((match) => ({ text: match[0].replace(/\r?\n$/, ""), start: match.index ?? 0 }))
    .filter((line, index, all) => index < all.length - 1 || line.text.length > 0);
  let servicesIndent: number | null = null;
  let service: string | null = null;
  let serviceIndent: number | null = null;
  let serviceFieldIndent: number | null = null;
  const seenBuild = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.text.trim() || /^\s*#/.test(line.text)) continue;
    if (/^\s*\t/.test(line.text)) {
      if (/\b(?:build|context|dockerfile)\s*:/.test(line.text)) {
        diagnostics.push({
          code: "unsupported_container_command",
          file,
          detail: `unsupported_compose_build_selector:${service ?? "services"}`
        });
      }
      continue;
    }
    const indent = line.text.match(/^ */)?.[0].length ?? 0;
    const trimmed = line.text.trim();
    if (trimmed === "services:") {
      servicesIndent = indent;
      service = null;
      serviceIndent = null;
      serviceFieldIndent = null;
      continue;
    }
    if (servicesIndent === null || indent <= servicesIndent) {
      if (indent <= (servicesIndent ?? -1)) servicesIndent = null;
      service = null;
      serviceIndent = null;
      serviceFieldIndent = null;
      continue;
    }
    const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!keyMatch) continue;
    if (serviceIndent === null || indent <= serviceIndent) {
      service = keyMatch[1];
      serviceIndent = indent;
      serviceFieldIndent = null;
      continue;
    }
    if (!service || indent <= serviceIndent) continue;
    if (serviceFieldIndent === null) serviceFieldIndent = indent;
    if (indent !== serviceFieldIndent || keyMatch[1] !== "build") continue;
    if (seenBuild.has(`${file}:${service}`)) {
      diagnostics.push({
        code: "unsupported_container_command",
        file,
        detail: `compose_build_selector_ambiguous:${service}`
      });
      continue;
    }
    seenBuild.add(`${file}:${service}`);
    const raw = keyMatch[2].trim();
    const start = line.start;
    if (raw !== "") {
      if (isUnsupportedComposeBuildNode(raw)) {
        diagnostics.push({
          code: "unsupported_container_command",
          file,
          detail: `unsupported_compose_build_selector:${service}`
        });
        continue;
      }
      const context = parseComposeScalar(raw);
      if (context === null) {
        diagnostics.push({
          code: "unsupported_container_command",
          file,
          detail: `unsupported_compose_build_selector:${service}`
        });
        continue;
      }
      candidates.push({
        file,
        service,
        context,
        dockerfile: "Dockerfile",
        start,
        end: start + line.text.length
      });
      continue;
    }

    let context = ".";
    let dockerfile = "Dockerfile";
    let end = start + line.text.length;
    let invalid = false;
    let ambiguous = false;
    let sawContext = false;
    let sawDockerfile = false;
    let mapIndent: number | null = null;
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      const child = lines[cursor];
      if (!child.text.trim() || /^\s*#/.test(child.text)) continue;
      const childIndent = child.text.match(/^ */)?.[0].length ?? 0;
      if (childIndent <= indent) break;
      end = child.start + child.text.length;
      if (mapIndent === null) mapIndent = childIndent;
      if (childIndent > mapIndent) continue;
      if (childIndent < mapIndent) {
        invalid = true;
        continue;
      }
      const childMatch = child.text.trim().match(/^([A-Za-z0-9_.<>-]+):\s*(.*)$/);
      if (!childMatch) {
        invalid = true;
        continue;
      }
      const name = childMatch[1];
      if (name === "<<" || name === "dockerfile_inline") {
        invalid = true;
        continue;
      }
      if (name !== "context" && name !== "dockerfile") continue;
      if ((name === "context" && sawContext) || (name === "dockerfile" && sawDockerfile)) {
        ambiguous = true;
        continue;
      }
      const value = childMatch[2].trim();
      if (isUnsupportedComposeBuildNode(value)) {
        invalid = true;
        continue;
      }
      const scalar = parseComposeScalar(value);
      if (scalar === null || scalar === "") {
        invalid = true;
        continue;
      }
      if (name === "context") {
        sawContext = true;
        context = scalar;
      } else {
        sawDockerfile = true;
        dockerfile = scalar;
      }
    }
    index = Math.max(index, cursor - 1);
    if (ambiguous) {
      diagnostics.push({
        code: "unsupported_container_command",
        file,
        detail: `compose_build_selector_ambiguous:${service}`
      });
    } else if (invalid) {
      diagnostics.push({
        code: "unsupported_container_command",
        file,
        detail: `unsupported_compose_build_selector:${service}`
      });
    } else {
      candidates.push({ file, service, context, dockerfile, start, end });
    }
  }
  return { candidates, diagnostics };
}

function isUnsupportedComposeBuildNode(value: string): boolean {
  const trimmed = value.trim();
  return (
    !trimmed ||
    trimmed === "|" ||
    trimmed === ">" ||
    /^[*!&[{]/.test(trimmed) ||
    /^!!/.test(trimmed) ||
    /^(?:null|~|true|false|[-+]?\d+(?:\.\d+)?)$/i.test(trimmed)
  );
}

export function discoverContainerCommandBindings(
  repositoryRoot: string,
  packageJsonText = readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  dockerfileText?: string,
  entrypointText?: string
): StructuralDiscovery {
  const observations: StructuralObservation[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const runtimeInvocationLedger: RuntimeInvocationLedgerEntry[] = [];
  const selectedDiscovery = dockerfileText === undefined
    ? discoverSelectedContainerDockerfiles(repositoryRoot)
    : {
        dockerfiles: [{
          file: "Dockerfile",
          source: dockerfileText,
          contextDirectory: resolve(repositoryRoot),
          selectorAnchors: []
        }],
        identityAnchors: dockerfileText.length > 0
          ? [{
              kind: "container_dockerfile" as const,
              file: "Dockerfile",
              targetFile: "Dockerfile",
              start: 0,
              end: dockerfileText.length
            }]
          : [],
        diagnostics: []
      };
  const structuralIdentityAnchors = selectedDiscovery.identityAnchors;
  diagnostics.push(...selectedDiscovery.diagnostics);
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return {
      observations,
      diagnostics: [{
        code: "unsupported_container_command",
        file: "package.json",
        detail: "package_json_parse_failed"
      }]
    };
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) return { observations, diagnostics };

  const bundles: Array<{
    readonly scriptName: string;
    readonly ownerModule: string;
    readonly outputPath: string;
    readonly anchorStart: number;
    readonly anchorEnd: number;
  }> = [];
  const esbuildPattern = /\besbuild\s+(?:"([^"]+\.[cm]?tsx?)"|'([^']+\.[cm]?tsx?)'|([^\s"';&|]+\.[cm]?tsx?))(?:(?!&&|\|\|).)*?--outfile(?:=|\s+)(?:"([^"]+\.[cm]?js)"|'([^']+\.[cm]?js)'|([^\s"';&|]+\.[cm]?js))/;
  for (const [scriptName, command] of Object.entries(parsed.scripts)) {
    if (typeof command !== "string" || !command.includes("esbuild")) continue;
    const match = command.match(esbuildPattern);
    if (!match) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: "package.json",
        detail: `unsupported_package_bundle_shape:${scriptName}`
      });
      continue;
    }
    const ownerModule = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^\.\//, "");
    const outputPath = (match[4] ?? match[5] ?? match[6] ?? "").replace(/^\.\//, "");
    if (
      !ownerModule.includes("/") ||
      ownerModule.includes("..") ||
      !outputPath.startsWith("dist/") ||
      outputPath.includes("..")
    ) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: "package.json",
        detail: `package_bundle_path_is_not_closed:${scriptName}`
      });
      continue;
    }
    const encodedCommand = JSON.stringify(command);
    const anchorStart = packageJsonText.indexOf(encodedCommand);
    bundles.push({
      scriptName,
      ownerModule,
      outputPath,
      anchorStart,
      anchorEnd: anchorStart + encodedCommand.length
    });
    observations.push({
      kind: "package_build_entrypoint",
      ownerModule,
      symbol: ownerModule,
      target: `${ownerModule}=>${outputPath}`,
      anchorFile: "package.json",
      anchorStart,
      anchorEnd: anchorStart + encodedCommand.length
    });
  }

  const buildCommand = parsed.scripts.build;
  for (const bundle of bundles) {
    const invocationPattern = new RegExp(
      `(?:^|\\s|&&|\\|\\|)npm\\s+run\\s+${escapeRegExp(bundle.scriptName)}(?:$|\\s|&&|\\|\\|)`
    );
    if (typeof buildCommand !== "string" || !invocationPattern.test(buildCommand)) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: "package.json",
        detail: `package_bundle_not_invoked_by_build:${bundle.scriptName}`
      });
    } else {
      const encodedBuild = JSON.stringify(buildCommand);
      const anchorStart = packageJsonText.indexOf(encodedBuild);
      observations.push({
        kind: "package_build_invocation",
        ownerModule: bundle.ownerModule,
        symbol: "build",
        target: `package.json#scripts.build:${bundle.scriptName}`,
        anchorFile: "package.json",
        anchorStart,
        anchorEnd: anchorStart + encodedBuild.length
      });
    }
  }

  const copies: Array<{
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly anchorFile: string;
    readonly anchorStart: number;
    readonly anchorEnd: number;
  }> = [];
  const copyPattern = /^\s*COPY\s+--from=builder\s+(\/app\/dist\/[^\s]+\.[cm]?js)\s+([^\s]+\.[cm]?js)\s*$/gm;
  for (const dockerfile of selectedDiscovery.dockerfiles) {
    for (const match of dockerfile.source.matchAll(copyPattern)) {
      if (match.index === undefined) continue;
      const destination = match[2].startsWith("/")
        ? match[2]
        : `/app/${match[2].replace(/^\.\//, "")}`;
      copies.push({
        sourcePath: match[1],
        destinationPath: destination,
        anchorFile: dockerfile.file,
        anchorStart: match.index,
        anchorEnd: match.index + match[0].length
      });
    }
    for (const line of dockerfile.source.split(/\r?\n/)) {
      if (
        line.includes("/app/dist/") &&
        /\.[cm]?js\b/.test(line) &&
        !copyPatternForLine(line)
      ) {
        diagnostics.push({
          code: "unsupported_container_command",
          file: dockerfile.file,
          detail: "unsupported_operational_bundle_copy_shape"
        });
      }
    }
  }

  const bundlesByOutput = new Map(bundles.map((bundle) => [bundle.outputPath, bundle]));
  for (const copy of copies) {
    const outputPath = copy.sourcePath.replace(/^\/app\//, "");
    const bundle = bundlesByOutput.get(outputPath);
    if (!bundle) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: copy.anchorFile,
        detail: `container_bundle_build_missing:${outputPath}`
      });
      continue;
    }
    observations.push({
      kind: "container_copy",
      ownerModule: bundle.ownerModule,
      symbol: outputPath.slice(outputPath.lastIndexOf("/") + 1),
      target: `${copy.anchorFile}#${copy.sourcePath}=>${copy.destinationPath}`,
      anchorFile: copy.anchorFile,
      anchorStart: copy.anchorStart,
      anchorEnd: copy.anchorEnd
    });
  }
  const copiedOutputs = new Set(copies.map((copy) => copy.sourcePath.replace(/^\/app\//, "")));
  for (const bundle of bundles) {
    if (!copiedOutputs.has(bundle.outputPath)) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: selectedDiscovery.dockerfiles[0]?.file ?? "Dockerfile",
        detail: `packaged_bundle_copy_missing:${bundle.outputPath}`
      });
    }
  }

  const bundlesByDestination = new Map<
    string,
    Array<{
      readonly bundle: typeof bundles[number];
      readonly dockerfile: string;
    }>
  >();
  for (const copy of copies) {
    const bundle = bundlesByOutput.get(copy.sourcePath.replace(/^\/app\//, ""));
    if (bundle) {
      const entries = bundlesByDestination.get(copy.destinationPath) ?? [];
      entries.push({ bundle, dockerfile: copy.anchorFile });
      bundlesByDestination.set(copy.destinationPath, entries);
    }
  }
  const recordInvocation = (
    invocation: EntrypointNodeInvocation,
    anchorFile: string,
    directive?: string,
    anchorSource?: string,
    selectedShell = false,
    imageDockerfile?: string
  ) => {
    const source = anchorSource ?? (
      existsSync(resolve(repositoryRoot, anchorFile))
        ? readFileSync(resolve(repositoryRoot, anchorFile), "utf8")
        : ""
    );
    const anchorBytes = invocation.start >= 0 && invocation.end <= source.length
      ? source.slice(invocation.start, invocation.end)
      : "";
    const addRuntimeLedgerEntry = (
      path: string | null,
      disposition: RuntimeInvocationLedgerEntry["disposition"],
      ownerModule: string | null,
      exclusion: RuntimeInvocationStructuralExclusion | null
    ) => {
      const role = invocation.kind === "static" && invocation.codeOption
        ? "code_module" as const
        : "main" as const;
      const canonical = {
        role,
        path,
        codeOption:
          invocation.kind === "static" || invocation.kind === "healthcheck_probe"
            ? invocation.codeOption ?? null
            : null,
        anchorFile,
        anchorStart: invocation.start,
        anchorEnd: invocation.end,
        anchorBytes,
        disposition,
        ownerModule,
        exclusion
      };
      const idTarget = path ?? (
        invocation.kind === "healthcheck_probe" ? "eval" : "dynamic"
      );
      const id = `runtime:${anchorFile}:${invocation.start}:${role}:${idTarget}`;
      runtimeInvocationLedger.push({
        id,
        ...canonical,
        fingerprint: sha256(stableJson({ id, ...canonical }))
      });
    };
    if (invocation.kind === "healthcheck_probe") {
      addRuntimeLedgerEntry(
        null,
        "structural_exclusion",
        null,
        {
          category: "healthcheck_probe_runtime",
          rationale:
            "Node healthcheck probe runtime without a repository module; observation-only structural exclusion"
        }
      );
      return;
    }
    if (invocation.kind === "unsupported_option") {
      addRuntimeLedgerEntry(null, "unsupported", null, null);
      diagnostics.push({
        code: "unsupported_container_command",
        file: anchorFile,
        detail: invocation.option === "dynamic"
          ? "unsupported_dynamic_node_option"
          : `unsupported_static_node_option:${invocation.option}`
      });
      return;
    }
    if (invocation.kind === "computed") {
      addRuntimeLedgerEntry(null, "unsupported", null, null);
      diagnostics.push({
        code: "unsupported_container_command",
        file: anchorFile,
        detail: "unsupported_computed_operational_mjs_invocation"
      });
      return;
    }
    if (invocation.kind === "dynamic") {
      addRuntimeLedgerEntry(null, "unsupported", null, null);
      diagnostics.push({
        code: "unsupported_container_command",
        file: anchorFile,
        detail: "unsupported_dynamic_node_invocation"
      });
      return;
    }
    const invocationPath = normalizeContainerInvocationPath(invocation.path);
    if (!invocationPath) {
      addRuntimeLedgerEntry(null, "unsupported", null, null);
      diagnostics.push({
        code: "unsupported_container_command",
        file: anchorFile,
        detail: "container_invocation_path_is_not_closed"
      });
      return;
    }
    const destinationCandidates = bundlesByDestination.get(invocationPath) ?? [];
    const imageCandidates = imageDockerfile
      ? destinationCandidates.filter(({ dockerfile }) => dockerfile === imageDockerfile)
      : destinationCandidates;
    const ownerCandidates = new Map(
      imageCandidates.map(({ bundle }) => [bundle.ownerModule, bundle])
    );
    if (ownerCandidates.size === 0) {
      const exclusion = selectedShell
        ? selectedShellRuntimeExclusion(anchorFile, invocationPath, anchorBytes)
        : null;
      if (exclusion) {
        addRuntimeLedgerEntry(
          invocationPath,
          "structural_exclusion",
          null,
          exclusion
        );
        return;
      }
      addRuntimeLedgerEntry(invocationPath, "unsupported", null, null);
      diagnostics.push({
        code: "unsupported_container_command",
        file: anchorFile,
        detail: `container_invocation_copy_missing:${invocationPath}`
      });
      return;
    }
    if (ownerCandidates.size !== 1) {
      addRuntimeLedgerEntry(invocationPath, "unsupported", null, null);
      diagnostics.push({
        code: "unsupported_container_command",
        file: anchorFile,
        detail: `container_invocation_copy_ambiguous:${invocationPath}`
      });
      return;
    }
    const bundle = ownerCandidates.values().next().value!;
    addRuntimeLedgerEntry(
      invocationPath,
      "container_invocation",
      bundle.ownerModule,
      null
    );
    observations.push({
      kind: "container_invocation",
      ownerModule: bundle.ownerModule,
      symbol: invocationPath.slice(invocationPath.lastIndexOf("/") + 1),
      target: directive
        ? `${anchorFile}#${directive}:${invocation.codeOption ? `${invocation.codeOption}:` : ""}${invocationPath}`
        : `${anchorFile}#${invocation.codeOption ? `${invocation.codeOption}:` : ""}${invocationPath}`,
      anchorFile,
      anchorStart: invocation.start,
      anchorEnd: invocation.end
    });
  };
  for (const dockerfile of selectedDiscovery.dockerfiles) {
    const composedDockerfile = discoverComposedDockerfileNodeInvocation(
      dockerfile.source
    );
    diagnostics.push(...composedDockerfile.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      file: dockerfile.file
    })));
    const dockerfileInvocations = composedDockerfile.handled
      ? composedDockerfile.invocations
      : discoverDockerfileNodeInvocations(dockerfile.source);
    for (const invocation of dockerfileInvocations) {
      recordInvocation(
        invocation,
        dockerfile.file,
        invocation.directive,
        dockerfile.source,
        false,
        dockerfile.file
      );
    }
  }
  if (entrypointText !== undefined) {
    for (const invocation of discoverEntrypointNodeInvocations(entrypointText)) {
      recordInvocation(
        invocation,
        "docker/entrypoint.sh",
        undefined,
        entrypointText,
        true,
        "Dockerfile"
      );
    }
  } else {
    const recordedShellSources = new Set<string>();
    for (const dockerfile of selectedDiscovery.dockerfiles) {
      const shellProvenance = discoverContainerShellProvenance(
        repositoryRoot,
        dockerfile.source,
        dockerfile.file,
        dockerfile.contextDirectory
      );
      diagnostics.push(...shellProvenance.diagnostics);
      for (const shell of shellProvenance.sources) {
        if (recordedShellSources.has(shell.sourceFile)) continue;
        recordedShellSources.add(shell.sourceFile);
        for (const invocation of shell.invocations) {
          recordInvocation(
            invocation,
            shell.sourceFile,
            undefined,
            shell.source,
            true,
            dockerfile.file
          );
        }
      }
    }
  }
  const composeOverrides = discoverComposeNodeInvocations(repositoryRoot);
  diagnostics.push(...composeOverrides.diagnostics);
  for (const override of composeOverrides.invocations) {
    recordInvocation(
      override.invocation,
      override.file,
      `services.${override.service}.${override.directive}`
    );
  }
  const composeHealthchecks = discoverComposeHealthcheckNodeInvocations(repositoryRoot);
  diagnostics.push(...composeHealthchecks.diagnostics);
  for (const healthcheck of composeHealthchecks.invocations) {
    recordInvocation(
      healthcheck.invocation,
      healthcheck.file,
      `services.${healthcheck.service}.healthcheck.test`
    );
  }
  return {
    observations,
    diagnostics,
    runtimeInvocationLedger,
    structuralIdentityAnchors
  };
}

function selectedShellRuntimeExclusion(
  anchorFile: string,
  path: string,
  anchorBytes: string
): RuntimeInvocationStructuralExclusion | null {
  if (
    anchorFile === "docker/entrypoint.sh" &&
    path === "/app/node_modules/prisma/build/index.js" &&
    anchorBytes ===
      "if ! node node_modules/prisma/build/index.js migrate deploy >/dev/null 2>&1"
  ) {
    return {
      category: "third_party_migration_cli",
      rationale: "third-party migration CLI runtime; observation-only structural exclusion"
    };
  }
  if (
    anchorFile === "docker/entrypoint.sh" &&
    path === "/app/server.js" &&
    anchorBytes === "exec node server.js"
  ) {
    return {
      category: "application_server_runtime",
      rationale: "copied application server runtime; observation-only structural exclusion"
    };
  }
  return null;
}

type ContainerShellCopyMapping = {
  readonly sourceFile: string;
  readonly destinationPath: string;
  readonly anchorStart: number;
  readonly anchorEnd: number;
};

type ContainerShellSelection = {
  readonly executablePath: string;
  readonly anchorFile: string;
  readonly anchorStart: number;
  readonly anchorEnd: number;
};

function discoverContainerShellProvenance(
  repositoryRoot: string,
  dockerfileText: string,
  dockerfileFile = "Dockerfile",
  contextDirectory = repositoryRoot
): {
  readonly sources: readonly {
    readonly sourceFile: string;
    readonly source: string;
    readonly invocations: readonly EntrypointNodeInvocation[];
  }[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
} {
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const mappings = parseFinalStageRepositoryShellMappings(
    repositoryRoot,
    dockerfileText,
    contextDirectory
  );
  const byDestination = new Map<string, ContainerShellCopyMapping[]>();
  for (const mapping of mappings) {
    const entries = byDestination.get(mapping.destinationPath) ?? [];
    entries.push(mapping);
    byDestination.set(mapping.destinationPath, entries);
  }
  const dockerSelections = discoverDockerfileShellSelections(
    dockerfileText,
    dockerfileFile
  );
  diagnostics.push(...dockerSelections.diagnostics);
  const composeSelections = discoverComposeShellSelections(repositoryRoot);
  diagnostics.push(...composeSelections.diagnostics);
  const sources = new Map<
    string,
    { readonly source: string; readonly invocations: readonly EntrypointNodeInvocation[] }
  >();
  const inspected = new Set<string>();
  const active = new Set<string>();

  const inspect = (selection: ContainerShellSelection) => {
    const normalized = normalizeContainerInvocationPath(selection.executablePath);
    if (!normalized) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: selection.anchorFile,
        detail: "container_shell_executable_path_is_not_closed"
      });
      return;
    }
    const candidates = byDestination.get(normalized) ?? [];
    if (candidates.length === 0) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: selection.anchorFile,
        detail: `container_shell_source_mapping_missing:${normalized}`
      });
      return;
    }
    if (candidates.length !== 1) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: selection.anchorFile,
        detail: `container_shell_source_mapping_ambiguous:${normalized}`
      });
      return;
    }
    const mapping = candidates[0];
    if (active.has(mapping.sourceFile)) {
      diagnostics.push({
        code: "unsupported_container_command",
        file: mapping.sourceFile,
        detail: `container_shell_source_cycle:${mapping.sourceFile}`
      });
      return;
    }
    if (inspected.has(mapping.sourceFile)) return;
    const absoluteSource = resolve(repositoryRoot, mapping.sourceFile);
    let source: string;
    try {
      if (!statSync(absoluteSource).isFile()) throw new Error("not_file");
      source = readFileSync(absoluteSource, "utf8");
    } catch {
      diagnostics.push({
        code: "unsupported_container_command",
        file: selection.anchorFile,
        detail: `container_shell_source_uninspectable:${mapping.sourceFile}`
      });
      return;
    }
    active.add(mapping.sourceFile);
    const invocations = discoverEntrypointNodeInvocations(source);
    sources.set(mapping.sourceFile, { source, invocations });
    for (const nestedPath of discoverNestedContainerShellExecutables(source)) {
      const nested = normalizeContainerInvocationPath(nestedPath);
      if (!nested) {
        diagnostics.push({
          code: "unsupported_container_command",
          file: mapping.sourceFile,
          detail: "container_shell_executable_path_is_not_closed"
        });
        continue;
      }
      if (
        byDestination.has(nested) ||
        /(?:\.sh$|entrypoint)/i.test(nested)
      ) {
        inspect({
          executablePath: nested,
          anchorFile: mapping.sourceFile,
          anchorStart: 0,
          anchorEnd: source.length
        });
      }
    }
    active.delete(mapping.sourceFile);
    inspected.add(mapping.sourceFile);
  };

  for (const selection of [...dockerSelections.selections, ...composeSelections.selections]) {
    inspect(selection);
  }
  return {
    sources: [...sources].map(([sourceFile, entry]) => ({
      sourceFile,
      source: entry.source,
      invocations: entry.invocations
    })),
    diagnostics
  };
}

function parseFinalStageRepositoryShellMappings(
  repositoryRoot: string,
  source: string,
  contextDirectory = repositoryRoot
): readonly ContainerShellCopyMapping[] {
  const finalFrom = [...source.matchAll(/^\s*FROM\s+[^\r\n]*/gmi)].at(-1);
  const finalStageStart = finalFrom?.index ?? 0;
  const finalStage = source.slice(finalStageStart);
  let workdir = "/";
  const mappings: ContainerShellCopyMapping[] = [];
  const instructionPattern = /^\s*(WORKDIR|COPY|ADD)\s+([^\r\n]*)/gmi;
  for (const match of finalStage.matchAll(instructionPattern)) {
    if (match.index === undefined) continue;
    const instruction = match[1].toUpperCase();
    const body = match[2].trim();
    if (instruction === "WORKDIR") {
      if (!/[\$`*?{}]/.test(body)) {
        workdir = body.startsWith("/")
          ? posix.normalize(body)
          : posix.resolve(workdir, body);
      }
      continue;
    }
    const parsed = parseStaticDockerCopyArguments(body);
    if (!parsed || parsed.fromStage || parsed.sources.length !== 1) continue;
    const sourceFile = parsed.sources[0].replace(/^\.\//, "").replaceAll("\\", "/");
    if (
      !sourceFile.endsWith(".sh") ||
      sourceFile.startsWith("/") ||
      sourceFile.startsWith("../") ||
      sourceFile.includes("/../") ||
      /[\$`*?{}]/.test(sourceFile)
    ) {
      continue;
    }
    let destinationPath = parsed.destination.startsWith("/")
      ? posix.normalize(parsed.destination)
      : posix.resolve(workdir, parsed.destination);
    if (parsed.destination.endsWith("/")) {
      destinationPath = posix.join(destinationPath, posix.basename(sourceFile));
    }
    const absolute = resolve(contextDirectory, sourceFile);
    const repositoryRelative = relative(repositoryRoot, absolute).replaceAll("\\", "/");
    if (
      repositoryRelative === ".." ||
      repositoryRelative.startsWith("../") ||
      isAbsolute(repositoryRelative)
    ) {
      continue;
    }
    mappings.push({
      sourceFile: repositoryRelative,
      destinationPath,
      anchorStart: finalStageStart + match.index,
      anchorEnd: finalStageStart + match.index + match[0].length
    });
  }
  return mappings;
}

function parseStaticDockerCopyArguments(body: string): {
  readonly sources: readonly string[];
  readonly destination: string;
  readonly fromStage: boolean;
} | null {
  if (body.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        !Array.isArray(parsed) ||
        parsed.length < 2 ||
        !parsed.every((entry) => typeof entry === "string")
      ) {
        return null;
      }
      return {
        sources: parsed.slice(0, -1),
        destination: parsed.at(-1)!,
        fromStage: false
      };
    } catch {
      return null;
    }
  }
  const commands = tokenizeShellCommands(body);
  if (commands.length !== 1 || commands[0].some((word) => !word.closed || word.dynamic)) {
    return null;
  }
  const words = [...commands[0]];
  let fromStage = false;
  while (words[0]?.value.startsWith("--")) {
    const option = words.shift()!.value;
    if (option === "--from" && words[0]) {
      fromStage = true;
      words.shift();
    } else if (option.startsWith("--from=")) {
      fromStage = true;
    }
  }
  if (words.length < 2) return null;
  return {
    sources: words.slice(0, -1).map((word) => word.value),
    destination: words.at(-1)!.value,
    fromStage
  };
}

function discoverDockerfileShellSelections(
  source: string,
  anchorFile = "Dockerfile"
): {
  readonly selections: readonly ContainerShellSelection[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
} {
  const directives = parseFinalDockerRuntimeDirectives(source);
  const entrypoint = [...directives].reverse().find(({ directive }) => directive === "ENTRYPOINT");
  const command = [...directives].reverse().find(({ directive }) => directive === "CMD");
  const selected = entrypoint ?? command;
  if (!selected) return { selections: [], diagnostics: [] };
  const executable = staticContainerShellExecutable(selected);
  if (executable.kind === "dynamic") {
    return {
      selections: [],
      diagnostics: [{
        code: "unsupported_container_command",
        file: anchorFile,
        detail: "container_shell_executable_is_dynamic"
      }]
    };
  }
  if (executable.kind !== "static") return { selections: [], diagnostics: [] };
  return {
    selections: [{
      executablePath: executable.path,
      anchorFile,
      anchorStart: selected.start,
      anchorEnd: selected.end
    }],
    diagnostics: []
  };
}

function staticContainerShellExecutable(
  field: DockerRuntimeDirective | ComposeCommandField
): { readonly kind: "static"; readonly path: string } |
  { readonly kind: "dynamic" } |
  { readonly kind: "none" } {
  const argv = "body" in field
    ? field.form === "exec"
      ? field.argv
      : composeShellWords(field.body)
    : composeFieldArgv(field);
  const rawValue = "body" in field ? field.body : field.value;
  if (!argv || argv.length === 0) {
    return /[\$`]/.test(rawValue)
      ? { kind: "dynamic" }
      : { kind: "none" };
  }
  const executableIndex = argv.findIndex((word, index) =>
    !["env", "exec"].includes(word) &&
    !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) &&
    argv.slice(0, index).every((prefix) =>
      ["env", "exec"].includes(prefix) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(prefix)
    )
  );
  if (executableIndex < 0) return { kind: "none" };
  const executable = argv[executableIndex];
  if (/[\$`]/.test(executable)) return { kind: "dynamic" };
  const basename = executable.replaceAll("\\", "/").split("/").at(-1) ?? executable;
  if (["node", "sh", "bash", "dash"].includes(basename)) return { kind: "none" };
  return executable.startsWith("/")
    ? { kind: "static", path: executable }
    : { kind: "none" };
}

function composeShellWords(value: string): readonly string[] | null {
  const commands = tokenizeShellCommands(value);
  return commands.length === 1 && commands[0].every(({ closed }) => closed)
    ? commands[0].map(({ value: word }) => word)
    : null;
}

function discoverComposeShellSelections(repositoryRoot: string): {
  readonly selections: readonly ContainerShellSelection[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
} {
  const selections: ContainerShellSelection[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  if (!existsSync(repositoryRoot)) return { selections, diagnostics };
  for (const file of discoverRepositoryComposeFiles(repositoryRoot)) {
    const parsed = parseComposeCommandFields(readFileSync(resolve(repositoryRoot, file), "utf8"));
    for (const [service, fields] of parsed.services) {
      const selected = fields.entrypoint ?? (!fields.entrypoint ? fields.command : undefined);
      if (!selected || selected.form === "unsupported") continue;
      const executable = staticContainerShellExecutable(selected);
      if (executable.kind === "dynamic") {
        diagnostics.push({
          code: "unsupported_container_command",
          file,
          detail: `container_shell_executable_is_dynamic:${service}`
        });
      } else if (executable.kind === "static") {
        selections.push({
          executablePath: executable.path,
          anchorFile: file,
          anchorStart: selected.start,
          anchorEnd: selected.end
        });
      }
    }
  }
  return { selections, diagnostics };
}

function discoverNestedContainerShellExecutables(source: string): readonly string[] {
  const executables = new Set<string>();
  for (const command of tokenizeShellCommands(source)) {
    const executable = command.find((word, index) =>
      word.closed &&
      !word.dynamic &&
      !isShellCommandPrefix(word) &&
      command.slice(0, index).every((prefix) => isShellCommandPrefix(prefix))
    );
    if (!executable || isNodeExecutableWord(executable.value)) continue;
    if (executable.value.startsWith("/")) executables.add(executable.value);
  }
  return [...executables];
}

function copyPatternForLine(line: string): boolean {
  return /^\s*COPY\s+--from=builder\s+\/app\/dist\/[^\s]+\.[cm]?js\s+[^\s]+\.[cm]?js\s*$/.test(line);
}

type ShellWord = {
  readonly value: string;
  readonly start: number;
  readonly end: number;
  readonly dynamic: boolean;
  readonly closed: boolean;
};

type ParsedNodeExecutable =
  | {
      readonly kind: "static";
      readonly word: ShellWord;
      readonly codeModules: readonly {
        readonly option: string;
        readonly word: ShellWord;
      }[];
    }
  | {
      readonly kind: "source";
      readonly option: "--eval" | "-e";
      readonly word: ShellWord;
      readonly codeModules: readonly {
        readonly option: string;
        readonly word: ShellWord;
      }[];
    }
  | { readonly kind: "dynamic"; readonly word: ShellWord | null }
  | { readonly kind: "unsupported_option"; readonly option: string }
  | { readonly kind: "none" };

const STATIC_NODE_FLAG_OPTIONS = new Set([
  "--enable-source-maps",
  "--no-warnings",
  "--trace-warnings",
  "--preserve-symlinks",
  "--preserve-symlinks-main"
]);

const STATIC_NODE_VALUE_OPTIONS = new Set([
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--experimental-loader",
  "--import",
  "--loader",
  "--require",
  "-r"
]);

const UNSAFE_NODE_SOURCE_OPTIONS = new Set([
  "--check",
  "--eval",
  "--print",
  "-c",
  "-e",
  "-p"
]);

function parseNodeExecutable(
  words: readonly ShellWord[],
  options: { readonly allowEvalSource?: boolean } = {}
): ParsedNodeExecutable {
  let index = 0;
  const codeModules: Array<{ readonly option: string; readonly word: ShellWord }> = [];
  while (index < words.length) {
    const word = words[index];
    if (!word.closed || word.dynamic) {
      return word.value.startsWith("-")
        ? { kind: "unsupported_option", option: "dynamic" }
        : { kind: "dynamic", word };
    }
    if (word.value === "--") {
      const executable = words[index + 1];
      if (!executable) return { kind: "none" };
      return !executable.closed || executable.dynamic
        ? { kind: "dynamic", word: executable }
        : { kind: "static", word: executable, codeModules };
    }
    if (!word.value.startsWith("-")) return { kind: "static", word, codeModules };
    if (
      options.allowEvalSource &&
      (word.value === "--eval" || word.value === "-e")
    ) {
      const value = words[index + 1];
      if (!value || !value.closed || value.dynamic) {
        return { kind: "unsupported_option", option: "dynamic" };
      }
      return {
        kind: "source",
        option: word.value,
        word: value,
        codeModules
      };
    }
    if (UNSAFE_NODE_SOURCE_OPTIONS.has(word.value)) {
      return { kind: "unsupported_option", option: word.value };
    }
    if (
      STATIC_NODE_FLAG_OPTIONS.has(word.value) ||
      /^--disable-warning=[A-Za-z0-9_-]+$/.test(word.value)
    ) {
      index += 1;
      continue;
    }
    const equals = word.value.indexOf("=");
    const optionName = equals >= 0 ? word.value.slice(0, equals) : word.value;
    if (STATIC_NODE_VALUE_OPTIONS.has(optionName)) {
      if (equals >= 0) {
        if (equals === word.value.length - 1) {
          return { kind: "unsupported_option", option: word.value };
        }
        if (isNodeCodeLoadingOption(optionName)) {
          codeModules.push({
            option: optionName,
            word: {
              ...word,
              value: word.value.slice(equals + 1),
              start: word.start + equals + 1
            }
          });
        }
        index += 1;
        continue;
      }
      const value = words[index + 1];
      if (!value || !value.closed || value.dynamic || value.value.startsWith("-")) {
        return { kind: "unsupported_option", option: "dynamic" };
      }
      if (isNodeCodeLoadingOption(optionName)) {
        codeModules.push({ option: optionName, word: value });
      }
      index += 2;
      continue;
    }
    return { kind: "unsupported_option", option: word.value };
  }
  return { kind: "none" };
}

function isNodeCodeLoadingOption(option: string): boolean {
  return [
    "--experimental-loader",
    "--import",
    "--loader",
    "--require",
    "-r"
  ].includes(option);
}

function discoverStaticNodeCommandExecutables(command: string): readonly ShellWord[] {
  const executables: ShellWord[] = [];
  for (const words of tokenizeShellCommands(command)) {
    const nodeIndex = words.findIndex(
      (word, index) =>
        !word.dynamic &&
        word.closed &&
        isNodeExecutableWord(word.value) &&
        words.slice(0, index).every((prefix) => isShellCommandPrefix(prefix))
    );
    if (nodeIndex < 0) continue;
    const executable = parseNodeExecutable(words.slice(nodeIndex + 1));
    if (executable.kind === "static") executables.push(executable.word);
  }
  return executables;
}

function isNodeExecutableWord(value: string): boolean {
  return value.replaceAll("\\", "/").split("/").at(-1) === "node";
}

function isNodeCapableDynamicExecutableWord(
  word: Pick<ShellWord, "value" | "closed">
): boolean {
  if (!word.closed || !/[\$`]/.test(word.value)) return false;
  const value = word.value.replaceAll("\\", "/");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) return false;
  return (
    isNodeExecutableWord(staticShellWordWithEmptyDynamicSegments(value) ?? "") ||
    /\$\{(?:NODE[A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*NODE[A-Za-z0-9_]*)(?::[-+=?]node)?\}/i.test(value) ||
    /\$(?:\{)?(?:NODE(?:_?BIN|_?EXEC(?:UTABLE)?|_?PATH)?|[A-Za-z_][A-Za-z0-9_]*NODE(?:_?BIN|_?EXEC(?:UTABLE)?|_?PATH)?)(?:\})?/i.test(value) ||
    /\$\{[^}]*:-node\}/i.test(value) ||
    /\$\([^)]*\b(?:command\s+-v|which)\s+node\b[^)]*\)/i.test(value)
  );
}

function staticShellWordWithEmptyDynamicSegments(value: string): string | null {
  let staticValue = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character === "`") {
      const end = value.indexOf("`", index + 1);
      if (end < 0) return null;
      index = end + 1;
      continue;
    }
    if (character !== "$") {
      staticValue += character;
      index += 1;
      continue;
    }
    const next = value[index + 1];
    if (next === "{" || next === "(") {
      const closing = next === "{" ? "}" : ")";
      let depth = 1;
      index += 2;
      while (index < value.length && depth > 0) {
        if (value[index] === "\\") {
          index += 2;
          continue;
        }
        if (value[index] === next) depth += 1;
        if (value[index] === closing) depth -= 1;
        index += 1;
      }
      if (depth !== 0) return null;
      continue;
    }
    if (next && /[A-Za-z_]/.test(next)) {
      index += 2;
      while (index < value.length && /[A-Za-z0-9_]/.test(value[index])) index += 1;
      continue;
    }
    if (next && /[0-9@*#?$!_-]/.test(next)) {
      index += 2;
      continue;
    }
    return null;
  }
  return staticValue;
}

type EntrypointNodeInvocation =
  | {
      readonly kind: "static";
      readonly path: string;
      readonly codeOption?: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "healthcheck_probe";
      readonly codeOption: "--eval" | "-e";
      readonly start: number;
      readonly end: number;
    }
  | { readonly kind: "computed"; readonly start: number; readonly end: number }
  | { readonly kind: "dynamic"; readonly start: number; readonly end: number }
  | {
      readonly kind: "unsupported_option";
      readonly option: string;
      readonly start: number;
      readonly end: number;
    };

type DockerfileNodeInvocation = EntrypointNodeInvocation & {
  readonly directive: "ENTRYPOINT" | "CMD" | "ENTRYPOINT+CMD";
};

type DockerRuntimeDirective = {
  readonly directive: "ENTRYPOINT" | "CMD";
  readonly body: string;
  readonly form: "exec" | "shell" | "invalid";
  readonly argv: readonly string[] | null;
  readonly start: number;
  readonly end: number;
};

function discoverComposedDockerfileNodeInvocation(source: string): {
  readonly handled: boolean;
  readonly invocations: readonly DockerfileNodeInvocation[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
} {
  const directives = parseFinalDockerRuntimeDirectives(source);
  const entrypoint = [...directives]
    .reverse()
    .find((entry) => entry.directive === "ENTRYPOINT");
  const command = [...directives]
    .reverse()
    .find((entry) => entry.directive === "CMD");
  if (!entrypoint || !command) {
    return { handled: false, invocations: [], diagnostics: [] };
  }

  const nodeEntrypoint =
    entrypoint.form === "exec" &&
    Boolean(entrypoint.argv?.length) &&
    isNodeExecutableWord(entrypoint.argv![0]);
  if (!nodeEntrypoint) {
    if (
      (entrypoint.form === "shell" || entrypoint.form === "invalid") &&
      containsOperationalContainerModuleToken(command.body)
    ) {
      return {
        handled: true,
        invocations: [],
        diagnostics: [{
          code: "unsupported_container_command",
          file: "Dockerfile",
          detail: "unsupported_docker_entrypoint_cmd_combination"
        }]
      };
    }
    return { handled: false, invocations: [], diagnostics: [] };
  }

  const start = Math.min(entrypoint.start, command.start);
  const end = Math.max(entrypoint.end, command.end);
  const entrypointOnly = parseNodeExecutable(
    entrypoint.argv!.slice(1).map((value) => ({
      value,
      start: entrypoint.start,
      end: entrypoint.end,
      dynamic: /[\$`]/.test(value),
      closed: true
    }))
  );
  if (entrypointOnly.kind === "static") {
    if (isOperationalContainerNodeModule(entrypointOnly.word.value)) {
      return { handled: false, invocations: [], diagnostics: [] };
    }
    return {
      handled: true,
      invocations: [],
      diagnostics: [{
        code: "unsupported_container_command",
        file: "Dockerfile",
        detail: "unsupported_docker_entrypoint_cmd_combination"
      }]
    };
  }
  if (command.form !== "exec" || !command.argv) {
    return {
      handled: true,
      invocations: [],
      diagnostics: [{
        code: "unsupported_container_command",
        file: "Dockerfile",
        detail: "unsupported_docker_entrypoint_cmd_combination"
      }]
    };
  }
  const parsed = parseNodeExecutable(
    [...entrypoint.argv!.slice(1), ...command.argv].map((value) => ({
      value,
      start,
      end,
      dynamic: /[\$`]/.test(value),
      closed: true
    }))
  );
  if (parsed.kind === "none") {
    return {
      handled: true,
      invocations: [],
      diagnostics: [{
        code: "unsupported_container_command",
        file: "Dockerfile",
        detail: "unsupported_docker_entrypoint_cmd_combination"
      }]
    };
  }
  if (parsed.kind === "unsupported_option") {
    return {
      handled: true,
      invocations: [{
        kind: "unsupported_option",
        option: parsed.option,
        directive: "ENTRYPOINT+CMD",
        start,
        end
      }],
      diagnostics: []
    };
  }
  if (parsed.kind === "dynamic") {
    return {
      handled: true,
      invocations: [{
        kind: parsed.word && containsOperationalContainerModuleToken(parsed.word.value)
          ? "computed"
          : "dynamic",
        directive: "ENTRYPOINT+CMD",
        start,
        end
      }],
      diagnostics: []
    };
  }
  return {
    handled: true,
    invocations: [
      ...parsed.codeModules.map(({ option, word }) => ({
        kind: "static" as const,
        path: word.value,
        codeOption: option,
        directive: "ENTRYPOINT+CMD" as const,
        start,
        end
      })),
      {
        kind: "static",
        path: parsed.word.value,
        directive: "ENTRYPOINT+CMD",
        start,
        end
      }
    ],
    diagnostics: []
  };
}

function parseFinalDockerRuntimeDirectives(
  source: string
): readonly DockerRuntimeDirective[] {
  const finalFrom = [...source.matchAll(/^\s*FROM\s+[^\r\n]*/gmi)].at(-1);
  const finalStageStart = finalFrom?.index ?? 0;
  const directives: DockerRuntimeDirective[] = [];
  const directivePattern = /^\s*(ENTRYPOINT|CMD)\s+([^\r\n]*)/gmi;
  for (const match of source.matchAll(directivePattern)) {
    if (match.index === undefined || match.index < finalStageStart) continue;
    const directive = match[1].toUpperCase() as "ENTRYPOINT" | "CMD";
    const body = match[2].trim();
    let form: DockerRuntimeDirective["form"] = "shell";
    let argv: readonly string[] | null = null;
    if (body.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(body);
        if (Array.isArray(parsed) && parsed.every((word) => typeof word === "string")) {
          form = "exec";
          argv = parsed;
        } else {
          form = "invalid";
        }
      } catch {
        form = "invalid";
      }
    }
    directives.push({
      directive,
      body,
      form,
      argv,
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return directives;
}

function discoverDockerfileNodeInvocations(
  source: string
): readonly DockerfileNodeInvocation[] {
  const invocations: DockerfileNodeInvocation[] = [];
  const directivePattern = /^\s*(ENTRYPOINT|CMD)\s+([^\r\n]*)/gmi;
  for (const match of source.matchAll(directivePattern)) {
    if (match.index === undefined) continue;
    const directive = match[1].toUpperCase() as "ENTRYPOINT" | "CMD";
    const body = match[2].trim();
    const anchorStart = match.index;
    const anchorEnd = match.index + match[0].length;
    const add = (invocation: EntrypointNodeInvocation) => {
      invocations.push({
        ...invocation,
        directive,
        start: anchorStart,
        end: anchorEnd
      });
    };
    if (body.startsWith("[")) {
      let words: unknown;
      try {
        words = JSON.parse(body);
      } catch {
        if (/\bnode\b/.test(body) || containsOperationalContainerModuleToken(body)) {
          add({ kind: "dynamic", start: anchorStart, end: anchorEnd });
        }
        continue;
      }
      if (!Array.isArray(words) || words.some((word) => typeof word !== "string")) {
        if (body.includes("node") || containsOperationalContainerModuleToken(body)) {
          add({ kind: "dynamic", start: anchorStart, end: anchorEnd });
        }
        continue;
      }
      const argv = words as string[];
      if (
        (argv[0] === "sh" || argv[0] === "bash" || argv[0] === "/bin/sh" || argv[0] === "/bin/bash") &&
        argv[1] === "-c" &&
        argv[2]
      ) {
        for (const invocation of discoverEntrypointNodeInvocations(argv[2])) add(invocation);
        continue;
      }
      const dynamicNodeIndex = argv.findIndex(
        (value, index) =>
          isNodeCapableDynamicExecutableWord({ value, closed: true }) &&
          argv.slice(0, index).every((prefix) => ["env", "exec"].includes(prefix))
      );
      if (dynamicNodeIndex >= 0) {
        add({ kind: "dynamic", start: anchorStart, end: anchorEnd });
        continue;
      }
      const nodeIndex = argv.findIndex(
        (word, index) =>
          isNodeExecutableWord(word) &&
          argv.slice(0, index).every((prefix) => ["env", "exec"].includes(prefix))
      );
      if (nodeIndex < 0) continue;
      const parsed = parseNodeExecutable(
        argv.slice(nodeIndex + 1).map((value) => ({
          value,
          start: anchorStart,
          end: anchorEnd,
          dynamic: /[\$`]/.test(value),
          closed: true
        }))
      );
      if (parsed.kind === "none") continue;
      if (parsed.kind === "unsupported_option") {
        add({
          kind: "unsupported_option",
          option: parsed.option,
          start: anchorStart,
          end: anchorEnd
        });
        continue;
      }
      if (parsed.kind === "dynamic") {
        const executable = parsed.word?.value ?? "";
        add({
          kind: containsOperationalContainerModuleToken(executable) ? "computed" : "dynamic",
          start: anchorStart,
          end: anchorEnd
        });
      } else {
        for (const codeModule of parsed.codeModules) {
          add({
            kind: "static",
            path: codeModule.word.value,
            codeOption: codeModule.option,
            start: anchorStart,
            end: anchorEnd
          });
        }
        add({
          kind: "static",
          path: parsed.word.value,
          start: anchorStart,
          end: anchorEnd
        });
      }
      continue;
    }
    for (const invocation of discoverEntrypointNodeInvocations(body)) add(invocation);
  }
  return invocations;
}

function discoverEntrypointNodeInvocations(
  source: string,
  options: { readonly allowHealthcheckEval?: boolean } = {}
): readonly EntrypointNodeInvocation[] {
  const invocations: EntrypointNodeInvocation[] = [];
  for (const command of tokenizeShellCommands(source)) {
    const dynamicNodeIndex = command.findIndex(
      (word, index) =>
        isNodeCapableDynamicExecutableWord(word) &&
        command.slice(0, index).every((prefix) => isShellCommandPrefix(prefix))
    );
    if (dynamicNodeIndex >= 0) {
      const invocationAnchor = selectedShellInvocationAnchor(
        source,
        command[dynamicNodeIndex].start
      );
      invocations.push({
        kind: "dynamic",
        start: invocationAnchor.start,
        end: invocationAnchor.end
      });
      continue;
    }
    const nodeIndex = command.findIndex(
      (word, index) =>
        !word.dynamic &&
        word.closed &&
        isNodeExecutableWord(word.value) &&
        command.slice(0, index).every((prefix) => isShellCommandPrefix(prefix))
    );
    if (nodeIndex < 0) {
      const operationalIndex = command.findIndex((word) =>
        isOperationalContainerNodeModule(word.value)
      );
      const executableIndex = command.findIndex(
        (word, index) =>
          !command.slice(0, index + 1).every((prefix) => isShellCommandPrefix(prefix))
      );
      const executable = executableIndex >= 0 ? command[executableIndex] : undefined;
      if (
        operationalIndex > executableIndex &&
        executableIndex >= 0 &&
        executable
      ) {
        invocations.push({
          kind: "dynamic",
          start: executable.start,
          end: executable.end
        });
      }
      continue;
    }
    const parsed = parseNodeExecutable(
      command.slice(nodeIndex + 1),
      { allowEvalSource: options.allowHealthcheckEval }
    );
    const invocationAnchor = selectedShellInvocationAnchor(
      source,
      command[nodeIndex].start
    );
    if (parsed.kind === "none") continue;
    if (parsed.kind === "unsupported_option") {
      const anchor = command[nodeIndex + 1] ?? command[nodeIndex];
      invocations.push({
        kind: "unsupported_option",
        option: parsed.option,
        start: invocationAnchor.start,
        end: invocationAnchor.end
      });
      continue;
    }
    if (parsed.kind === "dynamic") {
      const executable = parsed.word;
      invocations.push({
        kind: executable && containsOperationalContainerModuleToken(executable.value)
          ? "computed"
          : "dynamic",
        start: invocationAnchor.start,
        end: invocationAnchor.end
      });
      continue;
    }
    if (parsed.kind === "source") {
      invocations.push(
        ...healthcheckSourceInvocations(
          parsed,
          invocationAnchor.start,
          invocationAnchor.end
        )
      );
      continue;
    }
    const executable = parsed.word;
    for (const codeModule of parsed.codeModules) {
      invocations.push({
        kind: "static",
        path: codeModule.word.value,
        codeOption: codeModule.option,
        start: invocationAnchor.start,
        end: invocationAnchor.end
      });
    }
    invocations.push({
      kind: "static",
      path: executable.value,
      start: invocationAnchor.start,
      end: invocationAnchor.end
    });
  }
  const unparseableNodePattern = /(?:^|[\r\n;&|])\s*(?:exec\s+)?(?:"[^"\r\n]*[$`][^"\r\n]*"|\$\{[^}\r\n]+\}|\$\([^\r\n)]*\)|`[^`\r\n]+`)\s+(?:"[^"]+\.(?:[cm]?[jt]sx?)"|'[^']+\.(?:[cm]?[jt]sx?)'|[^\s;&|]+\.(?:[cm]?[jt]sx?))/gi;
  for (const match of source.matchAll(unparseableNodePattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (
      !invocations.some(
        (entry) => entry.kind === "dynamic" && entry.start >= start && entry.end <= end
      )
    ) {
      invocations.push({ kind: "dynamic", start, end });
    }
  }
  return invocations;
}

function selectedShellInvocationAnchor(
  source: string,
  nodeStart: number
): { readonly start: number; readonly end: number } {
  const lineStart = source.lastIndexOf("\n", nodeStart - 1) + 1;
  const lineEndIndex = source.indexOf("\n", nodeStart);
  const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
  const beforeNode = source.slice(lineStart, nodeStart);
  const control = [...beforeNode.matchAll(/(?:;|&&|\|\|)\s*/g)].at(-1);
  let start = lineStart + (control?.index ?? 0) + (control?.[0].length ?? 0);
  while (start < nodeStart && /\s/.test(source[start])) start += 1;
  const afterNode = source.slice(nodeStart, lineEnd);
  const terminator = afterNode.indexOf(";");
  let end = terminator < 0 ? lineEnd : nodeStart + terminator;
  while (end > nodeStart && /\s/.test(source[end - 1])) end -= 1;
  return { start, end };
}

type ComposeCommandField = {
  readonly form: "sequence" | "string" | "unsupported";
  readonly argv: readonly string[] | null;
  readonly value: string;
  readonly start: number;
  readonly end: number;
};

function discoverComposeNodeInvocations(repositoryRoot: string): {
  readonly invocations: readonly {
    readonly file: string;
    readonly service: string;
    readonly directive: "entrypoint" | "command" | "entrypoint+command";
    readonly invocation: EntrypointNodeInvocation;
  }[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
} {
  const invocations: Array<{
    readonly file: string;
    readonly service: string;
    readonly directive: "entrypoint" | "command" | "entrypoint+command";
    readonly invocation: EntrypointNodeInvocation;
  }> = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  if (!existsSync(repositoryRoot)) return { invocations, diagnostics };
  const files = [...discoverRepositoryComposeFiles(repositoryRoot)]
    .sort((left, right) => composeFileOrder(left) - composeFileOrder(right) || left.localeCompare(right));
  for (const file of files) {
    const source = readFileSync(resolve(repositoryRoot, file), "utf8");
    const parsed = parseComposeCommandFields(source);
    diagnostics.push(...parsed.diagnostics.map((detail) => ({
      code: "unsupported_container_command" as const,
      file,
      detail
    })));
    for (const [service, fields] of parsed.services) {
      const entrypoint = fields.entrypoint;
      const command = fields.command;
      if (!entrypoint && !command) continue;
      const operational = [entrypoint, command].some((field) =>
        field && /(?:\.mjs\b|\bnode\b|\$\{|`)/.test(field.value)
      );
      if (
        entrypoint?.form === "unsupported" ||
        command?.form === "unsupported"
      ) {
        diagnostics.push({
          code: "unsupported_container_command",
          file,
          detail: `unsupported_compose_command_shape:${service}`
        });
        continue;
      }
      const entrypointArgv = entrypoint ? composeFieldArgv(entrypoint) : null;
      const commandArgv = command ? composeFieldArgv(command) : null;
      if ((entrypoint && !entrypointArgv) || (command && !commandArgv)) {
        if (operational) {
          diagnostics.push({
            code: "unsupported_container_command",
            file,
            detail: `unsupported_compose_command_shape:${service}`
          });
        }
        continue;
      }
      let argv: readonly string[];
      let directive: "entrypoint" | "command" | "entrypoint+command";
      let start: number;
      let end: number;
      if (entrypointArgv && commandArgv) {
        argv = [...entrypointArgv, ...commandArgv];
        directive = "entrypoint+command";
        start = Math.min(entrypoint!.start, command!.start);
        end = Math.max(entrypoint!.end, command!.end);
      } else if (entrypointArgv) {
        argv = entrypointArgv;
        directive = "entrypoint";
        start = entrypoint!.start;
        end = entrypoint!.end;
      } else if (commandArgv) {
        argv = commandArgv;
        directive = "command";
        start = command!.start;
        end = command!.end;
      } else {
        continue;
      }
      const parsedInvocations = parseContainerNodeArgv(argv, start, end);
      if (parsedInvocations.length === 0 && operational) {
        diagnostics.push({
          code: "unsupported_container_command",
          file,
          detail: `unsupported_compose_container_executable:${service}`
        });
        continue;
      }
      for (const invocation of parsedInvocations) {
        invocations.push({ file, service, directive, invocation });
      }
    }
  }
  return { invocations, diagnostics };
}

type ResolvedYamlNode = {
  readonly kind: YamlListenerState["kind"];
  readonly result: unknown;
  readonly anchor: string | null;
  readonly start: number;
  readonly end: number;
};

function discoverComposeHealthcheckNodeInvocations(repositoryRoot: string): {
  readonly invocations: readonly {
    readonly file: string;
    readonly service: string;
    readonly invocation: EntrypointNodeInvocation;
  }[];
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
} {
  const invocations: Array<{
    readonly file: string;
    readonly service: string;
    readonly invocation: EntrypointNodeInvocation;
  }> = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  if (!existsSync(repositoryRoot)) return { invocations, diagnostics };
  const files = [...discoverRepositoryComposeFiles(repositoryRoot)]
    .sort((left, right) =>
      composeFileOrder(left) - composeFileOrder(right) || left.localeCompare(right)
    );
  for (const file of files) {
    const source = readFileSync(resolve(repositoryRoot, file), "utf8");
    const resolved = resolveComposeYaml(source);
    if (!resolved.document) {
      for (const anchor of findRawNodeCapableHealthcheckAnchors(source)) {
        invocations.push({
          file,
          service: "unresolved",
          invocation: { kind: "dynamic", ...anchor }
        });
      }
      if (invocations.some((entry) => entry.file === file)) {
        diagnostics.push({
          code: "unsupported_container_command",
          file,
          detail: "unsupported_compose_healthcheck_yaml"
        });
      }
      continue;
    }
    const services = isRecord(resolved.document.services)
      ? resolved.document.services
      : {};
    for (const [service, serviceValue] of Object.entries(services)) {
      if (!isRecord(serviceValue) || !("healthcheck" in serviceValue)) continue;
      const healthcheck = serviceValue.healthcheck;
      if (!isRecord(healthcheck) || !("test" in healthcheck)) {
        if (containsNodeCapableHealthcheckValue(healthcheck)) {
          const anchor = findResolvedYamlValueAnchor(
            source,
            healthcheck,
            serviceValue,
            resolved.nodes
          ) ?? findFallbackNodeAnchor(source, healthcheck);
          invocations.push({
            file,
            service,
            invocation: { kind: "dynamic", ...anchor }
          });
          diagnostics.push({
            code: "unsupported_container_command",
            file,
            detail: `unsupported_compose_healthcheck_test:${service}`
          });
        }
        continue;
      }
      const test = healthcheck.test;
      const anchor = findResolvedYamlValueAnchor(
        source,
        test,
        healthcheck,
        resolved.nodes
      ) ?? findFallbackNodeAnchor(source, test);
      const parsed = parseResolvedComposeHealthcheckTest(test, anchor.start, anchor.end);
      if (parsed.unsupported && containsNodeCapableHealthcheckValue(test)) {
        diagnostics.push({
          code: "unsupported_container_command",
          file,
          detail: `unsupported_compose_healthcheck_test:${service}`
        });
      }
      for (const invocation of parsed.invocations) {
        invocations.push({ file, service, invocation });
      }
    }
  }
  return { invocations, diagnostics };
}

function resolveComposeYaml(source: string): {
  readonly document: Record<string, unknown> | null;
  readonly nodes: readonly ResolvedYamlNode[];
} {
  const nodes: ResolvedYamlNode[] = [];
  const starts: number[] = [];
  let document: unknown;
  try {
    document = yamlLoad(source, {
      listener(event, state) {
        if (event === "open") {
          starts.push(state.position);
          return;
        }
        const start = starts.pop();
        if (start === undefined || state.position <= start) return;
        nodes.push({
          kind: state.kind,
          result: state.result,
          anchor: state.anchor,
          start,
          end: state.position
        });
      }
    });
  } catch {
    return { document: null, nodes };
  }
  return {
    document: isRecord(document) ? document : null,
    nodes
  };
}

function findResolvedYamlValueAnchor(
  source: string,
  value: unknown,
  container: Record<string, unknown>,
  nodes: readonly ResolvedYamlNode[],
  seen = new Set<object>()
): { readonly start: number; readonly end: number } | null {
  if (seen.has(container)) return null;
  seen.add(container);
  const containerNodes = nodes.filter(
    (node) => node.kind === "mapping" && node.result === container
  );
  const valueNodes = nodes.filter((node) =>
    node.result === value &&
    (Array.isArray(value)
      ? node.kind === "sequence"
      : isRecord(value)
        ? node.kind === "mapping"
        : node.kind === "scalar")
  );
  const contained = valueNodes
    .filter((node) => containerNodes.some(
      (parent) => node.start >= parent.start && node.end <= parent.end
    ))
    .sort(compareResolvedYamlNodes)[0];
  if (contained) return { start: contained.start, end: contained.end };

  for (const containerNode of containerNodes) {
    const bytes = source.slice(containerNode.start, containerNode.end);
    for (const match of bytes.matchAll(/\*([A-Za-z0-9_-]+)/g)) {
      const anchorNodes = nodes
        .filter((node) => node.anchor === match[1])
        .sort(compareResolvedYamlNodes);
      for (const anchorNode of anchorNodes) {
        if (anchorNode.result === value) {
          return { start: anchorNode.start, end: anchorNode.end };
        }
        if (isRecord(anchorNode.result)) {
          const nested = findResolvedYamlValueAnchor(
            source,
            value,
            anchorNode.result,
            nodes,
            seen
          );
          if (nested) return nested;
        }
      }
    }
  }

  if (typeof value === "object" && value !== null) {
    const exact = valueNodes.sort(compareResolvedYamlNodes)[0];
    return exact ? { start: exact.start, end: exact.end } : null;
  }
  const anchored = valueNodes
    .filter((node) => node.anchor !== null)
    .sort(compareResolvedYamlNodes);
  const anchorNames = new Set(anchored.map(({ anchor }) => anchor));
  if (anchorNames.size === 1 && anchored[0]) {
    return { start: anchored[0].start, end: anchored[0].end };
  }
  return null;
}

function compareResolvedYamlNodes(left: ResolvedYamlNode, right: ResolvedYamlNode): number {
  return (
    Number(right.anchor !== null) - Number(left.anchor !== null) ||
    (left.end - left.start) - (right.end - right.start) ||
    left.start - right.start
  );
}

function findFallbackNodeAnchor(
  source: string,
  value: unknown
): { readonly start: number; readonly end: number } {
  const hint = typeof value === "string"
    ? value.slice(0, Math.min(value.length, 32))
    : "node";
  const index = hint ? source.indexOf(hint) : -1;
  if (index >= 0) {
    const lineStart = source.lastIndexOf("\n", index - 1) + 1;
    const lineEndIndex = source.indexOf("\n", index);
    return {
      start: lineStart,
      end: lineEndIndex < 0 ? source.length : lineEndIndex
    };
  }
  return { start: 0, end: Math.max(1, source.length) };
}

function findRawNodeCapableHealthcheckAnchors(
  source: string
): readonly { readonly start: number; readonly end: number }[] {
  const anchors: Array<{ readonly start: number; readonly end: number }> = [];
  const lines = [...source.matchAll(/.*(?:\r?\n|$)/g)]
    .map((match) => ({ text: match[0].replace(/\r?\n$/, ""), start: match.index ?? 0 }))
    .filter((line, index, all) => index < all.length - 1 || line.text.length > 0);
  let healthcheckIndent: number | null = null;
  for (const line of lines) {
    if (!line.text.trim() || /^\s*#/.test(line.text)) continue;
    const indent = line.text.match(/^ */)?.[0].length ?? 0;
    if (/^\s*healthcheck\s*:/.test(line.text)) {
      healthcheckIndent = indent;
      continue;
    }
    if (healthcheckIndent === null) continue;
    if (indent <= healthcheckIndent) {
      healthcheckIndent = null;
      continue;
    }
    if (
      /^\s*test\s*:/.test(line.text) &&
      containsNodeCapableHealthcheckValue(line.text)
    ) {
      anchors.push({
        start: line.start,
        end: line.start + line.text.length
      });
    }
  }
  return anchors;
}

function parseResolvedComposeHealthcheckTest(
  value: unknown,
  start: number,
  end: number
): {
  readonly invocations: readonly EntrypointNodeInvocation[];
  readonly unsupported: boolean;
} {
  if (typeof value === "string") {
    const parsed = discoverEntrypointNodeInvocations(value, {
      allowHealthcheckEval: true
    }).map((invocation) => ({ ...invocation, start, end }));
    return parsed.length > 0 || !containsNodeCapableHealthcheckValue(value)
      ? { invocations: parsed, unsupported: false }
      : {
          invocations: [{ kind: "dynamic", start, end }],
          unsupported: true
        };
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return containsNodeCapableHealthcheckValue(value)
      ? {
          invocations: [{ kind: "dynamic", start, end }],
          unsupported: true
        }
      : { invocations: [], unsupported: true };
  }
  const [directive, ...command] = value;
  if (directive === "NONE" && command.length === 0) {
    return { invocations: [], unsupported: false };
  }
  if (directive === "CMD") {
    const parsed = parseContainerNodeArgv(command, start, end, {
      allowHealthcheckEval: true
    });
    return parsed.length > 0 || !containsNodeCapableHealthcheckValue(command)
      ? { invocations: parsed, unsupported: false }
      : {
          invocations: [{ kind: "dynamic", start, end }],
          unsupported: true
        };
  }
  if (directive === "CMD-SHELL" && command.length === 1) {
    const parsed = discoverEntrypointNodeInvocations(command[0], {
      allowHealthcheckEval: true
    }).map((invocation) => ({ ...invocation, start, end }));
    return parsed.length > 0 || !containsNodeCapableHealthcheckValue(command[0])
      ? { invocations: parsed, unsupported: false }
      : {
          invocations: [{ kind: "dynamic", start, end }],
          unsupported: true
        };
  }
  return containsNodeCapableHealthcheckValue(value)
    ? {
        invocations: [{ kind: "dynamic", start, end }],
        unsupported: true
      }
    : { invocations: [], unsupported: true };
}

function containsNodeCapableHealthcheckValue(
  value: unknown,
  seen = new Set<object>()
): boolean {
  if (typeof value === "string") {
    if (
      /(?:^|[\s/"'])node(?:$|[\s"'])/i.test(value) ||
      /\$(?:\{)?[A-Za-z_][A-Za-z0-9_]*NODE[A-Za-z0-9_]*(?:\})?/i.test(value) ||
      containsOperationalContainerModuleToken(value)
    ) {
      return true;
    }
    for (const command of tokenizeShellCommands(value)) {
      if (command.some((word) => isNodeCapableDynamicExecutableWord(word))) return true;
    }
    return false;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return false;
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((entry) =>
    containsNodeCapableHealthcheckValue(entry, seen)
  );
}

const COMPOSE_DISCOVERY_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "dist",
  "generated",
  "node_modules",
  "vendor"
]);

function discoverRepositoryComposeFiles(repositoryRoot: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!COMPOSE_DISCOVERY_EXCLUDED_DIRECTORIES.has(entry.name)) {
          visit(resolve(directory, entry.name));
        }
        continue;
      }
      if (
        entry.isFile() &&
        /(?:^|[.-])compose(?:[.-][A-Za-z0-9_-]+)*\.ya?ml$/i.test(entry.name)
      ) {
        files.push(relativeModule(repositoryRoot, resolve(directory, entry.name)));
      }
    }
  };
  visit(repositoryRoot);
  return files;
}

function composeFileOrder(file: string): number {
  const name = file.replaceAll("\\", "/").split("/").at(-1) ?? file;
  if (name === "docker-compose.yml" || name === "docker-compose.yaml") return 0;
  if (/^compose\.override\.ya?ml$/i.test(name)) return 1;
  if (/^compose\.ya?ml$/i.test(name)) return 2;
  return 3;
}

function parseComposeCommandFields(source: string): {
  readonly services: ReadonlyMap<
    string,
    { readonly entrypoint?: ComposeCommandField; readonly command?: ComposeCommandField }
  >;
  readonly diagnostics: readonly string[];
} {
  const services = new Map<
    string,
    { entrypoint?: ComposeCommandField; command?: ComposeCommandField }
  >();
  const diagnostics: string[] = [];
  const lines = [...source.matchAll(/.*(?:\r?\n|$)/g)]
    .map((match) => ({ text: match[0].replace(/\r?\n$/, ""), start: match.index ?? 0 }))
    .filter((line, index, all) => index < all.length - 1 || line.text.length > 0);
  let servicesIndent: number | null = null;
  let service: string | null = null;
  let serviceIndent: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.text.trim() || /^\s*#/.test(line.text)) continue;
    if (/^\s*\t/.test(line.text)) {
      if (/(?:entrypoint|command|\.mjs|node)/.test(line.text)) {
        diagnostics.push("unsupported_compose_indentation");
      }
      continue;
    }
    const indent = line.text.match(/^ */)?.[0].length ?? 0;
    const trimmed = line.text.trim();
    if (trimmed === "services:") {
      servicesIndent = indent;
      service = null;
      serviceIndent = null;
      continue;
    }
    if (servicesIndent === null || indent <= servicesIndent) {
      if (indent <= (servicesIndent ?? -1)) {
        servicesIndent = null;
        service = null;
      }
      continue;
    }
    if (/^<<\s*:/.test(trimmed)) {
      diagnostics.push(`unsupported_compose_merge_node:${service ?? "services"}`);
      continue;
    }
    const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!keyMatch) continue;
    if (serviceIndent === null || indent <= serviceIndent) {
      service = keyMatch[1];
      serviceIndent = indent;
      if (!services.has(service)) services.set(service, {});
      continue;
    }
    if (!service || indent <= serviceIndent) continue;
    const fieldName = keyMatch[1];
    if (fieldName !== "entrypoint" && fieldName !== "command") continue;
    const raw = keyMatch[2].trim();
    const fieldStart = line.start;
    let field: ComposeCommandField;
    if (raw.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(raw);
        field = Array.isArray(parsed) && parsed.every((word) => typeof word === "string")
          ? {
              form: "sequence",
              argv: parsed,
              value: raw,
              start: fieldStart,
              end: fieldStart + line.text.length
            }
          : {
              form: "unsupported",
              argv: null,
              value: raw,
              start: fieldStart,
              end: fieldStart + line.text.length
            };
      } catch {
        field = {
          form: "unsupported",
          argv: null,
          value: raw,
          start: fieldStart,
          end: fieldStart + line.text.length
        };
      }
    } else if (raw === "") {
      const argv: string[] = [];
      let end = fieldStart + line.text.length;
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const child = lines[cursor];
        if (!child.text.trim() || /^\s*#/.test(child.text)) continue;
        const childIndent = child.text.match(/^ */)?.[0].length ?? 0;
        if (childIndent <= indent) break;
        const item = child.text.trim().match(/^-\s+(.+)$/);
        if (!item) {
          argv.length = 0;
          break;
        }
        const scalar = parseComposeScalar(item[1]);
        if (scalar === null || isUnsupportedComposeCommandNode(item[1])) {
          argv.length = 0;
          break;
        }
        argv.push(scalar);
        end = child.start + child.text.length;
      }
      index = Math.max(index, cursor - 1);
      field = argv.length > 0
        ? { form: "sequence", argv, value: argv.join(" "), start: fieldStart, end }
        : { form: "unsupported", argv: null, value: raw, start: fieldStart, end };
    } else {
      const scalar = parseComposeScalar(raw);
      field = scalar === null || isUnsupportedComposeCommandNode(raw)
        ? {
            form: "unsupported",
            argv: null,
            value: raw,
            start: fieldStart,
            end: fieldStart + line.text.length
          }
        : {
            form: "string",
            argv: null,
            value: scalar,
            start: fieldStart,
            end: fieldStart + line.text.length
          };
    }
    services.get(service)![fieldName] = field;
  }
  const sourceFieldCount = [...source.matchAll(
    /^(?!\s*#)[^\r\n]*\b(?:entrypoint|command)\s*:/gmi
  )].length;
  const parsedFieldCount = [...services.values()].reduce(
    (count, fields) => count + Number(Boolean(fields.entrypoint)) + Number(Boolean(fields.command)),
    0
  );
  if (sourceFieldCount > parsedFieldCount) {
    diagnostics.push("unsupported_compose_command_structure");
  }
  return { services, diagnostics };
}

function isUnsupportedComposeCommandNode(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === "|" ||
    trimmed === ">" ||
    /^[*!&]/.test(trimmed) ||
    /^!!/.test(trimmed) ||
    /^\{/.test(trimmed)
  );
}

function parseComposeScalar(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("'")) {
    return trimmed.endsWith("'")
      ? trimmed.slice(1, -1).replaceAll("''", "'")
      : null;
  }
  return trimmed.replace(/\s+#.*$/, "");
}

function composeFieldArgv(field: ComposeCommandField): readonly string[] | null {
  if (field.form === "sequence") return field.argv;
  if (field.form !== "string") return null;
  const commands = tokenizeShellCommands(field.value);
  return commands.length === 1 && commands[0].every((word) => word.closed)
    ? commands[0].map((word) => word.value)
    : null;
}

const NODE_BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
]);

function healthcheckSourceInvocations(
  parsed: Extract<ParsedNodeExecutable, { readonly kind: "source" }>,
  start: number,
  end: number
): readonly EntrypointNodeInvocation[] {
  const invocations: EntrypointNodeInvocation[] = parsed.codeModules.map(
    ({ option, word }) => ({
      kind: "static" as const,
      path: word.value,
      codeOption: option,
      start,
      end
    })
  );
  const sourceModules = discoverHealthcheckSourceModules(parsed.word.value);
  invocations.push(
    ...sourceModules.paths.map((path) => ({
      kind: "static" as const,
      path,
      codeOption: parsed.option,
      start,
      end
    }))
  );
  if (sourceModules.unsupported) {
    invocations.push({
      kind: "unsupported_option",
      option: "dynamic",
      start,
      end
    });
  } else if (sourceModules.paths.length === 0) {
    invocations.push({
      kind: "healthcheck_probe",
      codeOption: parsed.option,
      start,
      end
    });
  }
  return invocations;
}

function discoverHealthcheckSourceModules(source: string): {
  readonly paths: readonly string[];
  readonly unsupported: boolean;
} {
  const sourceFile = ts.createSourceFile(
    "compose-healthcheck-eval.js",
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & {
      readonly parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics ?? [];
  const paths: string[] = [];
  let unsupported = parseDiagnostics.length > 0;
  const addModule = (specifier: ts.Expression | undefined) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      unsupported = true;
      return;
    }
    const value = specifier.text;
    if (NODE_BUILTIN_MODULES.has(value)) return;
    if (value.startsWith("/")) {
      paths.push(value);
      return;
    }
    if (value.startsWith("./") || value.startsWith("../")) {
      paths.push(posix.resolve("/app", value));
      return;
    }
    unsupported = true;
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) addModule(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) addModule(reference.expression);
      else unsupported = true;
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const loader =
        expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expression) && expression.text === "require") ||
        (ts.isPropertyAccessExpression(expression) && expression.name.text === "require");
      if (loader) {
        if (node.arguments.length !== 1) unsupported = true;
        addModule(node.arguments[0]);
      } else if (
        (ts.isIdentifier(expression) &&
          ["eval", "Function"].includes(expression.text)) ||
        (ts.isPropertyAccessExpression(expression) &&
          ["createRequire", "runInContext", "runInNewContext", "runInThisContext"]
            .includes(expression.name.text))
      ) {
        unsupported = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { paths, unsupported };
}

function parseContainerNodeArgv(
  argv: readonly string[],
  start: number,
  end: number,
  options: { readonly allowHealthcheckEval?: boolean } = {}
): readonly EntrypointNodeInvocation[] {
  const dynamicNodeIndex = argv.findIndex(
    (value, index) =>
      isNodeCapableDynamicExecutableWord({ value, closed: true }) &&
      argv.slice(0, index).every((prefix) => ["env", "exec"].includes(prefix))
  );
  if (dynamicNodeIndex >= 0) return [{ kind: "dynamic", start, end }];
  const nodeIndex = argv.findIndex(
    (word, index) =>
      isNodeExecutableWord(word) &&
      argv.slice(0, index).every((prefix) => ["env", "exec"].includes(prefix))
  );
  if (nodeIndex < 0) return [];
  const parsed = parseNodeExecutable(
    argv.slice(nodeIndex + 1).map((value) => ({
      value,
      start,
      end,
      dynamic: /[\$`]/.test(value),
      closed: true
    })),
    { allowEvalSource: options.allowHealthcheckEval }
  );
  if (parsed.kind === "none") return [];
  if (parsed.kind === "unsupported_option") {
    return [{ kind: "unsupported_option", option: parsed.option, start, end }];
  }
  if (parsed.kind === "dynamic") {
    return [{
      kind: parsed.word?.value.includes(".mjs") ? "computed" : "dynamic",
      start,
      end
    }];
  }
  if (parsed.kind === "source") {
    return healthcheckSourceInvocations(parsed, start, end);
  }
  return [
    ...parsed.codeModules.map(({ option, word }) => ({
      kind: "static" as const,
      path: word.value,
      codeOption: option,
      start,
      end
    })),
    { kind: "static" as const, path: parsed.word.value, start, end }
  ];
}

function containsOperationalContainerModuleToken(value: string): boolean {
  return /(?:^|[\s"'])[^\s"']+\.(?:[cm]?[jt]sx?)(?:$|[\s"'])/i.test(value);
}

function isOperationalContainerNodeModule(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(normalized)) return false;
  if (/(?:^|\/)node_modules\//.test(normalized)) return false;
  return !["server.js", "./server.js", "/app/server.js"].includes(normalized);
}

function isShellCommandPrefix(word: ShellWord): boolean {
  if (!word.closed) return false;
  if (/^(?:[A-Za-z_][A-Za-z0-9_]*)=/.test(word.value)) return true;
  if (word.dynamic) return false;
  return ["!", "command", "do", "elif", "else", "env", "exec", "if", "then"].includes(
    word.value
  );
}

function tokenizeShellCommands(source: string): readonly (readonly ShellWord[])[] {
  const commands: ShellWord[][] = [];
  let command: ShellWord[] = [];
  let index = 0;
  const finishCommand = () => {
    if (command.length > 0) commands.push(command);
    command = [];
  };

  while (index < source.length) {
    const character = source[index];
    if (/\s/.test(character)) {
      if (character === "\n" || character === "\r") finishCommand();
      index += 1;
      continue;
    }
    if (character === "#") {
      while (index < source.length && !/[\r\n]/.test(source[index])) index += 1;
      continue;
    }
    if (";&|()".includes(character)) {
      finishCommand();
      index += source[index + 1] === character ? 2 : 1;
      continue;
    }

    const start = index;
    let value = "";
    let dynamic = false;
    let closed = true;
    while (index < source.length) {
      const current = source[index];
      if (/\s/.test(current) || ";&|()".includes(current)) break;
      if (current === "\\") {
        index += 1;
        if (index >= source.length) {
          closed = false;
          break;
        }
        value += source[index];
        index += 1;
        continue;
      }
      if (current === "'" || current === '"') {
        const quote = current;
        index += 1;
        let quoteClosed = false;
        while (index < source.length) {
          const quoted = source[index];
          if (quoted === quote) {
            quoteClosed = true;
            index += 1;
            break;
          }
          if (quote === '"' && quoted === "\\" && index + 1 < source.length) {
            index += 1;
            value += source[index];
            index += 1;
            continue;
          }
          if (quote === '"' && (quoted === "$" || quoted === "`")) dynamic = true;
          value += quoted;
          index += 1;
        }
        if (!quoteClosed) closed = false;
        continue;
      }
      if (current === "$" || current === "`") dynamic = true;
      value += current;
      index += 1;
    }
    command.push({ value, start, end: index, dynamic, closed });
  }
  finishCommand();
  return commands;
}

function normalizeContainerInvocationPath(path: string): string | null {
  const normalized = path.startsWith("./")
    ? `/app/${path.slice(2)}`
    : path.startsWith("/")
      ? path
      : `/app/${path}`;
  if (
    normalized.includes("//") ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function discoverStructuralExclusions(
  repositoryRoot: string,
  packageJsonText = readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  availablePaths?: ReadonlySet<string>
): StructuralExclusionDiscovery {
  const exclusionsByOwner = new Map<string, StructuralExclusion>();
  const diagnostics: OperationRegistryDiagnostic[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return {
      exclusions: [],
      diagnostics: [
        {
          code: "stale_structural_exclusion",
          file: "package.json",
          detail: "package_json_parse_failed"
        }
      ]
    };
  }
  if (!isRecord(parsed) || !isRecord(parsed.scripts)) {
    return {
      exclusions: [],
      diagnostics: [
        {
          code: "stale_structural_exclusion",
          file: "package.json",
          detail: "package_scripts_missing"
        }
      ]
    };
  }
  const pathExists = (ownerModule: string) =>
    availablePaths
      ? availablePaths.has(ownerModule)
      : existsSync(resolve(repositoryRoot, ownerModule));
  for (const [scriptName, command] of Object.entries(parsed.scripts)) {
    if (typeof command !== "string") continue;
    const outputOperandRanges = discoverPackageOutputOperandRanges(command);
    for (const commandPath of extractRepositoryLocalCommandPaths(
      command,
      ["ts", "mjs"],
      outputOperandRanges
    )) {
      const ownerModule = commandPath.path;
      let category: StructuralExclusion["category"] | null = null;
      let rationale = "";
      if (ownerModule.includes("rehearsal")) {
        category = "rehearsal";
        rationale = "isolated test or rehearsal command; structural identity only";
      } else if (ownerModule === "prisma/seed.ts") {
        category = "fixture";
        rationale = "seed fixture command; excluded from operation semantics";
      } else if (ownerModule === "scripts/generate-brand-icons.mjs") {
        category = "build_tool";
        rationale = "generated product-asset build tool; excluded from operation semantics";
      } else if (ownerModule === "scripts/operation-registry.ts") {
        category = "registry_tooling";
        rationale = "operation-registry checker tooling; excluded from its owner inventory";
      }
      if (!pathExists(ownerModule)) {
        diagnostics.push({
          code: "stale_structural_exclusion",
          file: "package.json",
          detail: `excluded_owner_missing:${ownerModule}`
        });
        continue;
      }
      if (!category) continue;
      const existing = exclusionsByOwner.get(ownerModule);
      if (existing) {
        if (!existing.packageScripts.includes(scriptName)) {
          exclusionsByOwner.set(ownerModule, {
            ...existing,
            packageScripts: [...existing.packageScripts, scriptName]
          });
        }
      } else {
        exclusionsByOwner.set(ownerModule, {
          ownerModule,
          category,
          rationale,
          packageScripts: [scriptName]
        });
      }
    }
  }
  return { exclusions: [...exclusionsByOwner.values()], diagnostics };
}

export function buildRepositoryRegistry(
  repositoryRoot: string,
  requiredSidecars: ReadonlySet<string> = new Set()
): RepositoryRegistry {
  const program = loadRepositoryProgram(repositoryRoot);
  const sourceModules = program
    .getSourceFiles()
    .map((sourceFile) => relativeModule(repositoryRoot, sourceFile.fileName))
    .filter((file) => !file.startsWith("../") && !file.startsWith("..\\"));
  const discoveries: OperationRegistryDiagnostic[] = [];
  const executableCandidates = discoverRepositoryExecutableSourceCandidates(
    program,
    repositoryRoot
  );
  discoveries.push(...executableCandidates.diagnostics);
  const ownerEntries = new Map<
    string,
    { ownerKind: OperationOwnerKind; bindings: StructuralObservation[] }
  >();
  const addDiscovery = (
    ownerKind: OperationOwnerKind,
    discovery: StructuralDiscovery,
    kindForOwner?: (ownerModule: string) => OperationOwnerKind
  ) => {
    discoveries.push(...discovery.diagnostics);
    for (const observation of discovery.observations) {
      const existing = ownerEntries.get(observation.ownerModule);
      if (existing) {
        existing.bindings.push(observation);
      } else {
        ownerEntries.set(observation.ownerModule, {
          ownerKind: kindForOwner?.(observation.ownerModule) ?? ownerKind,
          bindings: [observation]
        });
      }
    }
  };

  const routeDiscovery = discoverRepositoryRouteModules(repositoryRoot);
  discoveries.push(...routeDiscovery.diagnostics);
  addDiscovery(
    "api_route",
    discoverRouteBindings(program, repositoryRoot, routeDiscovery.ownerModules)
  );

  const loaderCandidates = executableCandidates.loaderModules;
  addDiscovery(
    "server_loader",
    discoverServerLoaderBindings(program, repositoryRoot, loaderCandidates)
  );

  const clientBoundaries = executableCandidates.clientBoundaryModules;
  const clientClosure = discoverClientValueImportClosure(
    program,
    repositoryRoot,
    clientBoundaries
  );
  discoveries.push(...clientClosure.diagnostics);
  const clientCandidates = [...new Set([
    ...clientClosure.ownerModules,
    ...sourceModules
      .filter((file) => /\.(?:ts|tsx|mts|cts)$/.test(file))
      .filter((file) => !file.endsWith(".d.ts") && !file.endsWith(".operation.ts"))
      .filter((file) => {
        const sourceFile = program.getSourceFile(resolve(repositoryRoot, file));
        return Boolean(sourceFile && containsFormActionAttribute(sourceFile));
      })
  ])].sort();
  addDiscovery(
    "client_binding",
    discoverClientBindings(program, repositoryRoot, clientCandidates)
  );

  const actionCandidates = sourceModules
    .filter((file) => /\.(?:ts|tsx|mts|cts)$/.test(file))
    .filter((file) => !file.endsWith(".d.ts") && !file.endsWith(".operation.ts"))
    .sort();
  addDiscovery(
    "server_action",
    discoverServerActions(program, repositoryRoot, actionCandidates)
  );

  const instrumentationSource = program.getSourceFile(
    resolve(repositoryRoot, "src/instrumentation.ts")
  );
  const instrumentationWorkerOwners = (() => {
    if (!instrumentationSource) return [];
    const staticGraph = discoverStaticInstrumentationWorkerEntries(
      program.getTypeChecker(),
      instrumentationSource,
      repositoryRoot
    );
    const dynamicGraph = discoverInstrumentationDynamicWorkerGraph(
      program.getTypeChecker(),
      staticGraph.reachableSources,
      repositoryRoot
    );
    return [...staticGraph.entries, ...dynamicGraph.entries]
      .map((entry) => entry.ownerModule);
  })();
  const workerOwners = [...new Set([
    ...sourceModules.filter(
      (file) =>
        file === "src/instrumentation.ts" ||
        /^src\/server\/.+-scheduler\.ts$/.test(file)
    ),
    ...instrumentationWorkerOwners
  ])]
    .sort((left, right) => {
      if (left === "src/instrumentation.ts") return -1;
      if (right === "src/instrumentation.ts") return 1;
      return left.localeCompare(right);
    });
  addDiscovery(
    "worker",
    discoverWorkerWiring(program, repositoryRoot, workerOwners),
    (ownerModule) =>
      ownerModule === "src/instrumentation.ts" ? "instrumentation" : "worker"
  );

  addDiscovery(
    "package_command",
    discoverPackageCommands(program, repositoryRoot)
  );
  const containerDiscovery = discoverContainerCommandBindings(repositoryRoot);
  addDiscovery("package_command", containerDiscovery);
  const structuralIdentityAnchors = [
    ...(containerDiscovery.structuralIdentityAnchors ?? [])
  ].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.targetFile.localeCompare(right.targetFile) ||
      left.file.localeCompare(right.file) ||
      left.start - right.start ||
      left.end - right.end
  );

  const exclusionDiscovery = discoverStructuralExclusions(repositoryRoot);
  discoveries.push(...exclusionDiscovery.diagnostics);
  const exclusionsByOwner = new Map(
    exclusionDiscovery.exclusions.map((exclusion) => [exclusion.ownerModule, exclusion])
  );
  const categoryOrder: Record<OperationOwnerKind, number> = {
    api_route: 0,
    server_loader: 1,
    client_binding: 2,
    server_action: 3,
    instrumentation: 4,
    worker: 5,
    package_command: 6
  };
  const owners: NormalizedOwner[] = [...ownerEntries.entries()]
    .map(([ownerModule, entry]) => {
      const exclusion = exclusionsByOwner.get(ownerModule) ?? null;
      return {
        id: `${entry.ownerKind}:${ownerModule}`,
        ownerModule,
        ownerKind: entry.ownerKind,
        sidecarPath: sidecarPathForOwner(ownerModule),
        disposition: exclusion ? "excluded" as const : "observed" as const,
        exclusion,
        bindings: [...entry.bindings].sort(compareBindings)
      };
    })
    .sort(
      (left, right) =>
        categoryOrder[left.ownerKind] - categoryOrder[right.ownerKind] ||
        left.ownerModule.localeCompare(right.ownerModule)
    );

  const discoveredSidecars = new Set(owners.map((owner) => owner.sidecarPath));
  const appendixSidecars = new Set<string>(APPENDIX_A_SIDECAR_PATHS);
  for (const sidecarPath of appendixSidecars) {
    if (!discoveredSidecars.has(sidecarPath)) {
      discoveries.push({
        code: "observation_set_mismatch",
        file: sidecarPath,
        detail: "appendix_owner_not_discovered"
      });
    }
  }
  for (const sidecarPath of discoveredSidecars) {
    if (!appendixSidecars.has(sidecarPath)) {
      discoveries.push({
        code: "observation_set_mismatch",
        file: sidecarPath,
        detail: "discovered_owner_not_in_appendix"
      });
    }
  }

  const declarations: NormalizedDeclaration[] = [];
  const declarationIds = new Set<string>();
  const declarationPaths = new Set<string>();
  const existingSidecars = ts.sys
    .readDirectory(repositoryRoot, [".ts"], undefined, ["**/*.operation.ts"])
    .map((file) => relativeModule(repositoryRoot, file))
    .sort();
  for (const sidecarPath of existingSidecars) {
    const parsed = parseSidecarSource(
      sidecarPath,
      readFileSync(resolve(repositoryRoot, sidecarPath), "utf8")
    );
    discoveries.push(...parsed.diagnostics);
    if (!appendixSidecars.has(sidecarPath)) {
      discoveries.push({
        code: "extra_sidecar",
        file: sidecarPath,
        detail: "sidecar_is_outside_appendix_allowlist"
      });
      continue;
    }
    for (const declaration of parsed.declarations) {
      if (declarationIds.has(declaration.id)) {
        discoveries.push({
          code: "duplicate_declaration",
          file: sidecarPath,
          detail: `duplicate_declaration:${declaration.id}`
        });
      }
      declarationIds.add(declaration.id);
      declarationPaths.add(sidecarPath);
      declarations.push({ sidecarPath, declaration });
    }
  }

  const ownersByModule = new Map(owners.map((owner) => [owner.ownerModule, owner]));
  for (const normalized of declarations) {
    const owner = ownersByModule.get(normalized.declaration.ownerModule);
    if (!owner) {
      discoveries.push({
        code: "orphan_declaration",
        file: normalized.sidecarPath,
        detail: `owner_not_discovered:${normalized.declaration.ownerModule}`
      });
      continue;
    }
    if (normalized.sidecarPath !== owner.sidecarPath) {
      discoveries.push({
        code: "sidecar_path_mismatch",
        file: normalized.sidecarPath,
        detail: `expected_sidecar:${owner.sidecarPath}`
      });
    }
    if (
      normalized.declaration.id !== owner.id ||
      normalized.declaration.ownerKind !== owner.ownerKind
    ) {
      discoveries.push({
        code: "declaration_identity_mismatch",
        file: normalized.sidecarPath,
        detail: `expected_identity:${owner.id}`
      });
    }
    const declaredBindings = normalized.declaration.bindings
      .map(({ kind, symbol, target }) => ({ kind, symbol, target }))
      .sort(compareBindingDeclarations);
    const observedBindings = owner.bindings
      .map(({ kind, symbol, target }) => ({ kind, symbol, target }))
      .sort(compareBindingDeclarations);
    if (stableJson(declaredBindings) !== stableJson(observedBindings)) {
      discoveries.push({
        code: "declaration_binding_mismatch",
        file: normalized.sidecarPath,
        detail: `bindings_do_not_match:${owner.id}`
      });
    }
    if (
      normalized.declaration.disposition !== owner.disposition ||
      (owner.exclusion &&
        (normalized.declaration.exclusion?.category !== owner.exclusion.category ||
          normalized.declaration.exclusion?.rationale !== owner.exclusion.rationale)) ||
      (!owner.exclusion && normalized.declaration.exclusion !== undefined)
    ) {
      discoveries.push({
        code: "declaration_disposition_mismatch",
        file: normalized.sidecarPath,
        detail: `disposition_does_not_match:${owner.id}`
      });
    }
  }
  discoveries.push(
    ...validateGateEvidenceIntegrity(
      buildDeferredGateRegistry(),
      new Set(),
      declarations.map((entry) => entry.declaration)
    )
  );
  for (const required of requiredSidecars) {
    if (!declarationPaths.has(required)) {
      discoveries.push({
        code: "missing_sidecar",
        file: required,
        detail: "required_r0_sidecar_is_missing"
      });
    }
  }

  const declaredOwnerIds = new Set(declarations.map((entry) => entry.declaration.id));
  const omissionLedger = owners
    .filter((owner) => !declaredOwnerIds.has(owner.id))
    .map((owner) => ({
      id: owner.id,
      ownerModule: owner.ownerModule,
      sidecarPath: owner.sidecarPath,
      reason: "undeclared_owner" as const
    }));
  return {
    schemaVersion: 1,
    generatorVersion: "r0.1",
    authority: "observation_only",
    owners,
    declarations,
    exclusions: exclusionDiscovery.exclusions,
    runtimeInvocationLedger: containerDiscovery.runtimeInvocationLedger ?? [],
    structuralIdentityAnchors,
    omissionLedger,
    unresolvedLedger: discoveries,
    diagnostics: discoveries
  };
}

function sidecarPathForOwner(ownerModule: string): string {
  return ownerModule.replace(/\.(?:tsx|ts|mts|cts)$/, ".operation.ts");
}

function compareBindings(left: StructuralObservation, right: StructuralObservation): number {
  return compareBindingDeclarations(left, right);
}

function compareBindingDeclarations(
  left: { readonly kind: string; readonly symbol: string; readonly target: string },
  right: { readonly kind: string; readonly symbol: string; readonly target: string }
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.symbol.localeCompare(right.symbol) ||
    left.target.localeCompare(right.target)
  );
}

export const GENERATED_ARTIFACT_PATHS = [
  "src/server/operation-registry/generated/observation-registry.json",
  "src/server/operation-registry/generated/fingerprints.json",
  "src/server/operation-registry/generated/deferred-gates.json"
] as const;

export type GeneratedArtifactInput = {
  readonly observationRegistry: unknown;
  readonly fingerprints: unknown;
  readonly deferredGates: unknown;
};

export type RepositoryArtifacts = {
  readonly registry: RepositoryRegistry;
  readonly artifacts: Readonly<Record<(typeof GENERATED_ARTIFACT_PATHS)[number], string>>;
  readonly schemaDigest: string;
  readonly generatorDigest: string;
  readonly ownerSetDigestVersion: "owner-set.v1";
  readonly ownerSetDigest: string;
  readonly observationDigestVersion: "normalized-observation.v1";
  readonly observationDigest: string;
  readonly declarationDigestVersion: "normalized-declarations.v1";
  readonly declarationDigest: string;
  readonly deferredGateRegistryDigestVersion: "deferred-gates.v1";
  readonly deferredGateRegistryDigest: string;
  readonly runtimeInvocationLedgerDigestVersion: "selected-shell-runtime-ledger.v1";
  readonly runtimeInvocationLedgerDigest: string;
  readonly registryDigestVersion: "operation-registry.v1";
  readonly registryDigest: string;
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
};

export const OWNER_SET_DIGEST_VERSION = "owner-set.v1" as const;
export const OBSERVATION_DIGEST_VERSION = "normalized-observation.v1" as const;
export const DECLARATION_DIGEST_VERSION = "normalized-declarations.v1" as const;
export const DEFERRED_GATE_REGISTRY_DIGEST_VERSION = "deferred-gates.v1" as const;
export const RUNTIME_INVOCATION_LEDGER_DIGEST_VERSION =
  "selected-shell-runtime-ledger.v1" as const;
export const REGISTRY_DIGEST_VERSION = "operation-registry.v1" as const;

export function computeRuntimeInvocationLedgerDigest(
  ledger: readonly RuntimeInvocationLedgerEntry[]
): string {
  return sha256(stableJson({
    version: RUNTIME_INVOCATION_LEDGER_DIGEST_VERSION,
    invocations: ledger
  }));
}

export type RegistryDigestInput = {
  readonly ownerSetDigest: string;
  readonly observationDigest: string;
  readonly declarationDigest: string;
  readonly schemaDigest: string;
  readonly generatorDigest: string;
  readonly deferredGateRegistryBytes: string;
  readonly runtimeInvocationLedgerDigest?: string;
};

export type RegistryDigestResult = {
  readonly deferredGateRegistryDigestVersion: typeof DEFERRED_GATE_REGISTRY_DIGEST_VERSION;
  readonly deferredGateRegistryDigest: string;
  readonly registryDigestVersion: typeof REGISTRY_DIGEST_VERSION;
  readonly registryDigest: string;
};

export function computeRegistryDigest(input: RegistryDigestInput): RegistryDigestResult {
  const deferredGateRegistryDigest = sha256(input.deferredGateRegistryBytes);
  const registryDigest = sha256(stableJson({
    version: REGISTRY_DIGEST_VERSION,
    ownerSetDigest: input.ownerSetDigest,
    observationDigest: input.observationDigest,
    declarationDigest: input.declarationDigest,
    schemaDigest: input.schemaDigest,
    generatorDigest: input.generatorDigest,
    deferredGateRegistryBytes: input.deferredGateRegistryBytes,
    deferredGateRegistryDigest,
    runtimeInvocationLedgerDigest: input.runtimeInvocationLedgerDigest
  }));
  return {
    deferredGateRegistryDigestVersion: DEFERRED_GATE_REGISTRY_DIGEST_VERSION,
    deferredGateRegistryDigest,
    registryDigestVersion: REGISTRY_DIGEST_VERSION,
    registryDigest
  };
}

export function buildRepositoryArtifacts(repositoryRoot: string): RepositoryArtifacts {
  const registry = buildRepositoryRegistry(repositoryRoot);
  const schemaBytes = readFileSync(
    resolve(repositoryRoot, "src/server/operation-registry/schema.ts"),
    "utf8"
  );
  const generatorFiles = [
    "src/server/operation-registry/checker.ts",
    "src/server/operation-registry/schema.ts",
    "scripts/operation-registry.ts"
  ];
  const schemaDigest = sha256(schemaBytes);
  const generatorDigest = sha256(
    stableJson(
      generatorFiles.map((file) => ({
        file,
        digest: sha256(readFileSync(resolve(repositoryRoot, file), "utf8"))
      }))
    )
  );
  const ownerSetCanonical = registry.owners.map((owner) => ({
    id: owner.id,
    ownerModule: owner.ownerModule,
    ownerKind: owner.ownerKind,
    sidecarPath: owner.sidecarPath
  }));
  const ownerSetDigest = sha256(
    stableJson({
      version: OWNER_SET_DIGEST_VERSION,
      owners: ownerSetCanonical
    })
  );
  const anchorDiagnostics: OperationRegistryDiagnostic[] = [];
  const anchorFileBytes = new Map<string, string>();
  const readAnchorFile = (file: string): string => {
    const cached = anchorFileBytes.get(file);
    if (cached !== undefined) return cached;
    const target = resolve(repositoryRoot, file);
    const relativeTarget = relativeModule(repositoryRoot, target);
    if (
      relativeTarget.startsWith("../") ||
      relativeTarget.startsWith("..\\") ||
      !existsSync(target)
    ) {
      anchorDiagnostics.push({
        code: "unresolved_fingerprint_anchor",
        file,
        detail: "structural_anchor_file_missing_or_outside_repository"
      });
      anchorFileBytes.set(file, "");
      return "";
    }
    const bytes = readFileSync(target, "utf8");
    anchorFileBytes.set(file, bytes);
    return bytes;
  };
  const observationCanonical = registry.owners.map((owner) => ({
    id: owner.id,
    ownerModule: owner.ownerModule,
    ownerKind: owner.ownerKind,
    sidecarPath: owner.sidecarPath,
    disposition: owner.disposition,
    exclusion: owner.exclusion,
    bindings: owner.bindings.map((binding) => {
      const source = readAnchorFile(binding.anchorFile);
      const valid =
        Number.isInteger(binding.anchorStart) &&
        Number.isInteger(binding.anchorEnd) &&
        binding.anchorStart >= 0 &&
        binding.anchorEnd > binding.anchorStart &&
        binding.anchorEnd <= source.length;
      if (!valid) {
        anchorDiagnostics.push({
          code: "unresolved_fingerprint_anchor",
          file: binding.anchorFile,
          detail: `unresolved_observation_anchor:${owner.id}:${binding.kind}:${binding.symbol}`
        });
      }
      const anchorBytes = valid ? source.slice(binding.anchorStart, binding.anchorEnd) : "";
      return {
        kind: binding.kind,
        symbol: binding.symbol,
        target: binding.target,
        anchorFile: binding.anchorFile,
        anchorStart: binding.anchorStart,
        anchorEnd: binding.anchorEnd,
        anchorDigest: valid ? sha256(anchorBytes) : null
      };
    })
  }));
  const structuralIdentityCanonical = registry.structuralIdentityAnchors.map(
    (anchor) => {
      const source = readAnchorFile(anchor.file);
      const valid =
        Number.isInteger(anchor.start) &&
        Number.isInteger(anchor.end) &&
        anchor.start >= 0 &&
        anchor.end > anchor.start &&
        anchor.end <= source.length;
      if (!valid) {
        anchorDiagnostics.push({
          code: "unresolved_fingerprint_anchor",
          file: anchor.file,
          detail: `unresolved_structural_identity_anchor:${anchor.kind}:${anchor.targetFile}`
        });
      }
      return {
        ...anchor,
        anchorDigest: valid
          ? sha256(source.slice(anchor.start, anchor.end))
          : null
      };
    }
  );
  const runtimeInvocationLedgerCanonical = registry.runtimeInvocationLedger.map(
    (entry) => {
      const source = readAnchorFile(entry.anchorFile);
      const valid =
        Number.isInteger(entry.anchorStart) &&
        Number.isInteger(entry.anchorEnd) &&
        entry.anchorStart >= 0 &&
        entry.anchorEnd > entry.anchorStart &&
        entry.anchorEnd <= source.length &&
        source.slice(entry.anchorStart, entry.anchorEnd) === entry.anchorBytes;
      if (!valid) {
        anchorDiagnostics.push({
          code: "unresolved_fingerprint_anchor",
          file: entry.anchorFile,
          detail: `unresolved_runtime_invocation_anchor:${entry.id}`
        });
      }
      const { fingerprint, ...fingerprintInput } = entry;
      if (fingerprint !== sha256(stableJson(fingerprintInput))) {
        anchorDiagnostics.push({
          code: "fingerprint_mismatch",
          file: entry.anchorFile,
          detail: `runtime_invocation_fingerprint_changed:${entry.id}`
        });
      }
      return entry;
    }
  );
  const runtimeInvocationLedgerDigest = computeRuntimeInvocationLedgerDigest(
    runtimeInvocationLedgerCanonical
  );
  const observationDigest = sha256(
    stableJson({
      version: OBSERVATION_DIGEST_VERSION,
      owners: observationCanonical,
      runtimeInvocationLedger: runtimeInvocationLedgerCanonical,
      structuralIdentityAnchors: structuralIdentityCanonical
    })
  );
  const declarationCanonical = registry.declarations
    .map((entry) => ({
      sidecarPath: entry.sidecarPath,
      declaration: {
        schemaVersion: entry.declaration.schemaVersion,
        id: entry.declaration.id,
        ownerModule: entry.declaration.ownerModule,
        ownerKind: entry.declaration.ownerKind,
        bindings: [...entry.declaration.bindings].sort(compareBindingDeclarations),
        disposition: entry.declaration.disposition,
        ...(entry.declaration.exclusion === undefined
          ? {}
          : { exclusion: entry.declaration.exclusion }),
        deferredGateIds: [...entry.declaration.deferredGateIds].sort()
      }
    }))
    .sort((left, right) =>
      left.declaration.id.localeCompare(right.declaration.id) ||
      left.sidecarPath.localeCompare(right.sidecarPath)
    );
  const declarationDigest = sha256(stableJson({
    version: DECLARATION_DIGEST_VERSION,
    declarations: declarationCanonical
  }));
  const deferredGateRegistry = buildDeferredGateRegistry();
  const deferredGateRegistryBytes = stableJson(deferredGateRegistry);
  const aggregateDigests = computeRegistryDigest({
    ownerSetDigest,
    observationDigest,
    declarationDigest,
    schemaDigest,
    generatorDigest,
    deferredGateRegistryBytes,
    runtimeInvocationLedgerDigest
  });
  const declarationsById = new Map(
    registry.declarations.map((entry) => [entry.declaration.id, entry])
  );
  const fingerprintDiagnostics: OperationRegistryDiagnostic[] = [];
  const fingerprintEntries = registry.owners.map((owner) => {
    const ownerBytes = readAnchorFile(owner.ownerModule);
    const declaration = declarationsById.get(owner.id);
    const sidecarBytes = declaration
      ? readFileSync(resolve(repositoryRoot, declaration.sidecarPath), "utf8")
      : "";
    const fingerprintBindings = owner.bindings.map((binding) => ({
      kind: binding.kind,
      symbol: binding.symbol,
      target: binding.target,
      anchorFile: binding.anchorFile,
      anchorStart: binding.anchorStart,
      anchorEnd: binding.anchorEnd
    }));
    const boundDockerfiles = new Set(
      fingerprintBindings
        .map(({ anchorFile }) => anchorFile)
        .filter((file) =>
          registry.structuralIdentityAnchors.some(
            (anchor) =>
              anchor.kind === "container_dockerfile" &&
              anchor.targetFile === file
          )
        )
    );
    const fingerprintStructuralIdentityAnchors =
      registry.structuralIdentityAnchors.filter((anchor) =>
        boundDockerfiles.has(anchor.targetFile)
      );
    const fingerprintAnchorFiles = [...new Set([
      owner.ownerModule,
      ...fingerprintBindings.map((binding) => binding.anchorFile),
      ...fingerprintStructuralIdentityAnchors.map((anchor) => anchor.file)
    ])]
      .sort()
      .map((file) => ({ file, digest: sha256(readAnchorFile(file)) }));
    const fingerprintAnchorBytes = Object.fromEntries(
      fingerprintAnchorFiles.map(({ file }) => [file, readAnchorFile(file)])
    );
    const sourceDigest = sha256(
      stableJson({
        ownerDigest: sha256(ownerBytes),
        anchorFiles: fingerprintAnchorFiles,
        bindings: fingerprintBindings.map((binding) => ({
          ...binding,
          anchorBytes: fingerprintAnchorBytes[binding.anchorFile].slice(
            binding.anchorStart,
            binding.anchorEnd
          )
        })),
        structuralIdentityAnchors: fingerprintStructuralIdentityAnchors.map(
          (anchor) => ({
            ...anchor,
            anchorBytes: fingerprintAnchorBytes[anchor.file].slice(
              anchor.start,
              anchor.end
            )
          })
        ),
        schemaDigest,
        generatorDigest
      })
    );
    if (!declaration) {
      return {
        id: `fingerprint:${owner.id}`,
        ownerId: owner.id,
        ownerModule: owner.ownerModule,
        sidecarPath: owner.sidecarPath,
        status: "omitted" as const,
        sourceDigest,
        anchorFiles: fingerprintAnchorFiles,
        declarationDigest: null,
        fingerprint: null
      };
    }
    const computed = computeStructuralFingerprint({
      id: owner.id,
      ownerModule: owner.ownerModule,
      ownerBytes,
      sidecarPath: declaration.sidecarPath,
      sidecarBytes,
      anchorFiles: fingerprintAnchorBytes,
      bindings: fingerprintBindings,
      schemaDigest,
      generatorDigest
    });
    fingerprintDiagnostics.push(...computed.diagnostics);
    return {
      id: `fingerprint:${owner.id}`,
      ownerId: owner.id,
      ownerModule: owner.ownerModule,
      sidecarPath: owner.sidecarPath,
      status: "declared" as const,
      sourceDigest,
      anchorFiles: fingerprintAnchorFiles,
      declarationDigest: sha256(sidecarBytes),
      fingerprint: computed.digest
    };
  });
  const metadata = {
    schemaVersion: 1,
    generatorVersion: registry.generatorVersion,
    authority: registry.authority,
    schemaDigest,
    generatorDigest,
    ownerSetDigestVersion: OWNER_SET_DIGEST_VERSION,
    ownerSetDigest,
    observationDigestVersion: OBSERVATION_DIGEST_VERSION,
    observationDigest,
    declarationDigestVersion: DECLARATION_DIGEST_VERSION,
    declarationDigest,
    runtimeInvocationLedgerDigestVersion: RUNTIME_INVOCATION_LEDGER_DIGEST_VERSION,
    runtimeInvocationLedgerDigest,
    ...aggregateDigests
  };
  const artifacts = renderGeneratedArtifacts({
    observationRegistry: {
      ...metadata,
      observationCount: registry.owners.length,
      ownerSetCanonical,
      observationCanonical,
      structuralIdentityAnchors: structuralIdentityCanonical,
      categoryCounts: Object.fromEntries(
        [...new Set(registry.owners.map((owner) => owner.ownerKind))]
          .sort()
          .map((kind) => [
            kind,
            registry.owners.filter((owner) => owner.ownerKind === kind).length
          ])
      ),
      owners: registry.owners.map((owner) => ({
        id: owner.id,
        ownerModule: owner.ownerModule,
        ownerKind: owner.ownerKind,
        sidecarPath: owner.sidecarPath,
        disposition: owner.disposition,
        bindings: owner.bindings
      })),
      declarations: registry.declarations.map((entry) => ({
        id: entry.declaration.id,
        sidecarPath: entry.sidecarPath,
        declaration: entry.declaration
      })),
      exclusions: registry.exclusions,
      runtimeInvocationLedger: runtimeInvocationLedgerCanonical,
      omissionLedger: registry.omissionLedger,
      unresolvedLedger: registry.unresolvedLedger
    },
    fingerprints: {
      ...metadata,
      fingerprints: fingerprintEntries,
      runtimeInvocationFingerprints: runtimeInvocationLedgerCanonical.map(
        ({ id, fingerprint }) => ({ id, fingerprint })
      )
    },
    deferredGates: {
      ...metadata,
      ...deferredGateRegistry
    }
  });
  return {
    registry,
    artifacts,
    schemaDigest,
    generatorDigest,
    ownerSetDigestVersion: OWNER_SET_DIGEST_VERSION,
    ownerSetDigest,
    observationDigestVersion: OBSERVATION_DIGEST_VERSION,
    observationDigest,
    declarationDigestVersion: DECLARATION_DIGEST_VERSION,
    declarationDigest,
    runtimeInvocationLedgerDigestVersion: RUNTIME_INVOCATION_LEDGER_DIGEST_VERSION,
    runtimeInvocationLedgerDigest,
    ...aggregateDigests,
    diagnostics: [
      ...registry.diagnostics,
      ...anchorDiagnostics,
      ...fingerprintDiagnostics
    ]
  };
}

export function writeRepositoryArtifacts(repositoryRoot: string): RepositoryArtifacts {
  const built = buildRepositoryArtifacts(repositoryRoot);
  const unexpected = checkUnexpectedGeneratedArtifacts(repositoryRoot);
  if (built.diagnostics.length > 0 || unexpected.length > 0) {
    return {
      ...built,
      diagnostics: [...built.diagnostics, ...unexpected]
    };
  }
  for (const [file, content] of Object.entries(built.artifacts)) {
    const target = resolve(repositoryRoot, file);
    const generatedRoot = resolve(
      repositoryRoot,
      "src/server/operation-registry/generated"
    );
    if (!target.startsWith(generatedRoot)) {
      throw new Error("operation_registry_generated_path_escape");
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
  return built;
}

export function checkRepositoryArtifacts(
  repositoryRoot: string
): readonly OperationRegistryDiagnostic[] {
  const built = buildRepositoryArtifacts(repositoryRoot);
  const availableSidecars = new Set(
    built.registry.declarations.map((entry) => entry.sidecarPath)
  );
  return [
    ...built.diagnostics,
    ...checkRegistryCompletion(built.registry),
    ...checkGeneratedArtifacts(repositoryRoot, built.artifacts, availableSidecars)
  ];
}

export function checkRegistryCompletion(
  registry: Pick<RepositoryRegistry, "omissionLedger">
): readonly OperationRegistryDiagnostic[] {
  return registry.omissionLedger.map((entry) => ({
      code: "missing_sidecar" as const,
      file: entry.sidecarPath,
      detail: `undeclared_owner:${entry.id}`
    }));
}

export function renderGeneratedArtifacts(
  input: GeneratedArtifactInput
): Readonly<Record<(typeof GENERATED_ARTIFACT_PATHS)[number], string>> {
  return {
    [GENERATED_ARTIFACT_PATHS[0]]: stableJson(input.observationRegistry),
    [GENERATED_ARTIFACT_PATHS[1]]: stableJson(input.fingerprints),
    [GENERATED_ARTIFACT_PATHS[2]]: stableJson(input.deferredGates)
  };
}

export function checkGeneratedArtifacts(
  repositoryRoot: string,
  expected: Readonly<Record<string, string>>,
  availableSidecars: ReadonlySet<string>
): readonly OperationRegistryDiagnostic[] {
  const diagnostics: OperationRegistryDiagnostic[] = [
    ...checkUnexpectedGeneratedArtifacts(repositoryRoot)
  ];
  for (const [file, expectedContent] of Object.entries(expected)) {
    const target = resolve(repositoryRoot, file);
    if (!existsSync(target) || !statSync(target).isFile()) {
      diagnostics.push({
        code: "missing_generated_artifact",
        file,
        detail: "generated_artifact_is_missing"
      });
      continue;
    }
    const actualContent = readFileSync(target, "utf8");
    if (actualContent !== expectedContent) {
      diagnostics.push({
        code: "generated_artifact_mismatch",
        file,
        detail: "generated_bytes_do_not_match"
      });
    }
  }

  const registryPath = GENERATED_ARTIFACT_PATHS[0];
  const registryTarget = resolve(repositoryRoot, registryPath);
  if (existsSync(registryTarget) && expected[registryPath]) {
    try {
      const actual = JSON.parse(readFileSync(registryTarget, "utf8"));
      const expectedRegistry = JSON.parse(expected[registryPath]);
      const actualOwners = generatedRows(actual, "owners");
      const expectedOwners = generatedRows(expectedRegistry, "owners");
      const seen = new Set<string>();
      for (const row of actualOwners) {
        if (seen.has(row.id)) {
          diagnostics.push({
            code: "duplicate_generated_id",
            file: registryPath,
            detail: `duplicate_owner:${row.id}`
          });
        }
        seen.add(row.id);
      }
      const expectedIds = new Set(expectedOwners.map((row) => row.id));
      for (const row of actualOwners) {
        if (!expectedIds.has(row.id)) {
          diagnostics.push({
            code: "stale_generated_row",
            file: registryPath,
            detail: `stale_owner:${row.id}`
          });
        }
      }
      for (const declaration of generatedRows(expectedRegistry, "declarations")) {
        if (
          typeof declaration.sidecarPath === "string" &&
          !availableSidecars.has(declaration.sidecarPath)
        ) {
          diagnostics.push({
            code: "missing_sidecar",
            file: declaration.sidecarPath,
            detail: `declared_sidecar_missing:${declaration.id}`
          });
        }
      }
    } catch {
      diagnostics.push({
        code: "generated_artifact_mismatch",
        file: registryPath,
        detail: "generated_registry_json_invalid"
      });
    }
  }
  const aggregateMetadataFields = [
    "schemaDigest",
    "generatorDigest",
    "ownerSetDigestVersion",
    "ownerSetDigest",
    "observationDigestVersion",
    "observationDigest",
    "declarationDigestVersion",
    "declarationDigest",
    "deferredGateRegistryDigestVersion",
    "deferredGateRegistryDigest",
    "runtimeInvocationLedgerDigestVersion",
    "runtimeInvocationLedgerDigest",
    "registryDigestVersion",
    "registryDigest"
  ] as const;
  const parsedArtifacts: Array<{ readonly file: string; readonly value: Record<string, unknown> }> = [];
  for (const file of GENERATED_ARTIFACT_PATHS) {
    const target = resolve(repositoryRoot, file);
    if (!existsSync(target)) continue;
    try {
      const value = JSON.parse(readFileSync(target, "utf8"));
      if (isRecord(value)) parsedArtifacts.push({ file, value });
    } catch {
      // The byte comparison and artifact-specific parser report malformed JSON.
    }
  }
  if (parsedArtifacts.length === GENERATED_ARTIFACT_PATHS.length) {
    for (const field of aggregateMetadataFields) {
      const values = parsedArtifacts.map((artifact) => artifact.value[field]);
      if (
        values.some((value) => !isNonBlankString(value)) ||
        new Set(values).size !== 1
      ) {
        diagnostics.push({
          code: "generated_artifact_mismatch",
          file: "src/server/operation-registry/generated",
          detail: `aggregate_metadata_cross_file_mismatch:${field}`
        });
      }
    }
    const observationArtifact = parsedArtifacts.find(
      ({ file }) => file === GENERATED_ARTIFACT_PATHS[0]
    );
    if (observationArtifact) {
      const ledger = observationArtifact.value.runtimeInvocationLedger;
      const version = observationArtifact.value.runtimeInvocationLedgerDigestVersion;
      const digest = observationArtifact.value.runtimeInvocationLedgerDigest;
      if (
        !Array.isArray(ledger) ||
        version !== RUNTIME_INVOCATION_LEDGER_DIGEST_VERSION ||
        digest !== computeRuntimeInvocationLedgerDigest(
          ledger.filter(isGeneratedRuntimeInvocationLedgerEntry)
        ) ||
        ledger.length !== ledger.filter(isGeneratedRuntimeInvocationLedgerEntry).length
      ) {
        diagnostics.push({
          code: "generated_artifact_mismatch",
          file: GENERATED_ARTIFACT_PATHS[0],
          detail: "runtime_invocation_ledger_digest_mismatch"
        });
      }
    }
  }
  return diagnostics;
}

function isGeneratedRuntimeInvocationLedgerEntry(
  value: unknown
): value is RuntimeInvocationLedgerEntry {
  return isRecord(value) &&
    isNonBlankString(value.id) &&
    (value.role === "main" || value.role === "code_module") &&
    (value.path === null || isNonBlankString(value.path)) &&
    (value.codeOption === null || isNonBlankString(value.codeOption)) &&
    isNonBlankString(value.anchorFile) &&
    Number.isInteger(value.anchorStart) &&
    Number.isInteger(value.anchorEnd) &&
    typeof value.anchorBytes === "string" &&
    ["container_invocation", "structural_exclusion", "unsupported"].includes(
      String(value.disposition)
    ) &&
    (value.ownerModule === null || isNonBlankString(value.ownerModule)) &&
    (value.exclusion === null || isRecord(value.exclusion)) &&
    typeof value.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.fingerprint);
}

function checkUnexpectedGeneratedArtifacts(
  repositoryRoot: string
): readonly OperationRegistryDiagnostic[] {
  const generatedRoot = resolve(
    repositoryRoot,
    "src/server/operation-registry/generated"
  );
  if (!existsSync(generatedRoot) || !statSync(generatedRoot).isDirectory()) return [];
  const allowed = new Set<string>(GENERATED_ARTIFACT_PATHS);
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const target = resolve(directory, entry.name);
      const file = relativeModule(repositoryRoot, target);
      if (!allowed.has(file)) {
        diagnostics.push({
          code: "unexpected_generated_artifact",
          file,
          detail: entry.isDirectory()
            ? "unexpected_generated_directory"
            : "unexpected_generated_file"
        });
      }
      if (entry.isDirectory()) visit(target);
    }
  };
  visit(generatedRoot);
  return diagnostics;
}

function generatedRows(value: unknown, property: string): Array<Record<string, unknown> & { id: string }> {
  if (!isRecord(value) || !Array.isArray(value[property])) return [];
  return value[property].filter(
    (entry): entry is Record<string, unknown> & { id: string } =>
      isRecord(entry) && typeof entry.id === "string"
  );
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value), null, 2)}\n`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonValue(entry)])
  );
}

export type StructuralFingerprintBinding = {
  readonly kind: string;
  readonly symbol: string;
  readonly target: string;
  readonly anchorStart: number;
  readonly anchorEnd: number;
  readonly anchorFile?: string;
  readonly anchorSource?: "owner" | "package";
};

export type StructuralFingerprintInput = {
  readonly id: string;
  readonly ownerModule: string;
  readonly ownerBytes: string;
  readonly sidecarPath: string;
  readonly sidecarBytes: string;
  readonly packageBytes?: string;
  readonly anchorFiles?: Readonly<Record<string, string>>;
  readonly bindings: readonly StructuralFingerprintBinding[];
  readonly schemaDigest: string;
  readonly generatorDigest: string;
};

export type StructuralFingerprintResult = {
  readonly digest: string | null;
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
};

export function computeStructuralFingerprint(
  input: StructuralFingerprintInput
): StructuralFingerprintResult {
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const bindings = input.bindings.map((binding) => {
    const anchorFile = binding.anchorFile ??
      (binding.anchorSource === "package" ? "package.json" : input.ownerModule);
    const source = input.anchorFiles?.[anchorFile] ??
      (anchorFile === input.ownerModule
        ? input.ownerBytes
        : anchorFile === "package.json"
          ? input.packageBytes
          : undefined);
    if (
      source === undefined ||
      !Number.isInteger(binding.anchorStart) ||
      !Number.isInteger(binding.anchorEnd) ||
      binding.anchorStart < 0 ||
      binding.anchorEnd <= binding.anchorStart ||
      binding.anchorEnd > source.length ||
      !binding.target ||
      binding.target.includes("unresolved")
    ) {
      diagnostics.push({
        code: "unresolved_fingerprint_anchor",
        file: anchorFile,
        detail: `unresolved_anchor:${binding.kind}:${binding.symbol}`
      });
      return null;
    }
    const anchorBytes = source.slice(binding.anchorStart, binding.anchorEnd);
    if (!anchorBytes.trim()) {
      diagnostics.push({
        code: "unresolved_fingerprint_anchor",
        file: anchorFile,
        detail: `empty_anchor:${binding.kind}:${binding.symbol}`
      });
      return null;
    }
    return {
      kind: binding.kind,
      symbol: binding.symbol,
      target: binding.target,
      anchorFile,
      anchorBytes
    };
  });
  if (diagnostics.length > 0) return { digest: null, diagnostics };
  const payload = {
    id: input.id,
    ownerModule: input.ownerModule,
    ownerDigest: sha256(input.ownerBytes),
    sidecarPath: input.sidecarPath,
    sidecarDigest: sha256(input.sidecarBytes),
    anchorFiles: Object.entries(
      input.anchorFiles ?? {
        [input.ownerModule]: input.ownerBytes,
        ...(input.packageBytes === undefined ? {} : { "package.json": input.packageBytes })
      }
    )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, bytes]) => ({ file, digest: sha256(bytes) })),
    bindings,
    schemaDigest: input.schemaDigest,
    generatorDigest: input.generatorDigest
  };
  return { digest: sha256(stableJson(payload)), diagnostics: [] };
}

export function validateStructuralFingerprint(
  expectedDigest: string,
  input: StructuralFingerprintInput
): readonly OperationRegistryDiagnostic[] {
  const computed = computeStructuralFingerprint(input);
  if (computed.diagnostics.length > 0) return computed.diagnostics;
  if (computed.digest === expectedDigest) return [];
  return [
    {
      code: "fingerprint_mismatch",
      file: input.ownerModule,
      detail: `fingerprint_changed:${input.id}`
    }
  ];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type DeferredGateRegistry = {
  readonly schemaVersion: 1;
  readonly authority: "observation_only";
  readonly gates: readonly DeferredGateDefinition[];
  readonly evidence: readonly unknown[];
};

const DEFERRED_GATES = [
  {
    id: "gate.carrier_authority_guard",
    status: "deferred",
    rationale: "Carrier and authority-guard semantics are outside structural observation.",
    dependencyPhase: "R2",
    blockedAxes: ["carrier_authority_guard"],
    exitCriteria: "Review exact carrier and authority guard anchors in R2."
  },
  {
    id: "gate.caller_controlled_scope",
    status: "deferred",
    rationale: "Caller-controlled and opening-scope inputs are not inferred from callsites.",
    dependencyPhase: "R2",
    blockedAxes: ["caller_controlled_scope"],
    exitCriteria: "Review caller-controlled inputs and opening scope in R2."
  },
  {
    id: "gate.service_operation_linkage",
    status: "deferred",
    rationale: "Service-operation linkage is not part of R0/R1 sidecars.",
    dependencyPhase: "R2",
    blockedAxes: ["service_operation_linkage"],
    exitCriteria: "Add separately approved service declarations and exact linkage in R2."
  },
  {
    id: "gate.permission_commit_reauthorization",
    status: "deferred",
    rationale: "Permission and commit-time reauthorization semantics require service review.",
    dependencyPhase: "R2",
    blockedAxes: ["permission_commit_reauthorization"],
    exitCriteria: "Review permission and commit reauthorization anchors in R2."
  },
  {
    id: "gate.tenant_relationship_invariants",
    status: "deferred",
    rationale: "Tenant predicates and relationship invariants are not derived structurally.",
    dependencyPhase: "R2",
    blockedAxes: ["tenant_relationship_invariants"],
    exitCriteria: "Review tenant predicates and relationship invariants in R2."
  },
  {
    id: "gate.model_and_effects",
    status: "deferred",
    rationale: "Model reads, writes, and local or external effects remain unknown.",
    dependencyPhase: "R2",
    blockedAxes: ["model_reads_writes_effects"],
    exitCriteria: "Review exact model and effect-sink anchors in R2."
  },
  {
    id: "gate.variant_outcomes",
    status: "deferred",
    rationale: "Variant-specific outcomes cannot be proven by entrypoint identity.",
    dependencyPhase: "R2",
    blockedAxes: ["variant_specific_outcomes"],
    exitCriteria: "Define and review each variant-specific outcome in R2."
  },
  {
    id: "gate.worker_containment",
    status: "deferred",
    rationale: "Worker loop, claim, and failure containment semantics are not inferred from wiring.",
    dependencyPhase: "R2",
    blockedAxes: ["worker_loop_claim_failure_containment"],
    exitCriteria: "Review worker loop, claim, and failure containment anchors in R2."
  },
  {
    id: "gate.browser_binding_staleness",
    status: "deferred",
    rationale: "Browser immutable binding and stale behavior remain separate inventory work.",
    dependencyPhase: "R3",
    blockedAxes: ["browser_immutable_binding_stale_behavior"],
    exitCriteria: "Complete the separately approved browser binding inventory in R3."
  },
  {
    id: "gate.executable_evidence",
    status: "deferred",
    rationale: "Executable evidence strength is outside observation-only source delivery.",
    dependencyPhase: "R4",
    blockedAxes: ["executable_evidence_strength"],
    exitCriteria: "Produce fingerprint-bound executable hostile evidence in R4."
  }
] as const satisfies readonly DeferredGateDefinition[];

export function buildDeferredGateRegistry(): DeferredGateRegistry {
  return {
    schemaVersion: 1,
    authority: "observation_only",
    gates: DEFERRED_GATES,
    evidence: []
  };
}

export function validateGateEvidenceIntegrity(
  registry: DeferredGateRegistry,
  fingerprintIds: ReadonlySet<string>,
  declarations: readonly OperationDeclaration[] = []
): readonly OperationRegistryDiagnostic[] {
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const expectedIds = new Set(DEFERRED_GATES.map((gate) => gate.id));
  const actualIds: string[] = [];
  if (
    !isRecord(registry) ||
    Object.keys(registry).sort().join(",") !== "authority,evidence,gates,schemaVersion" ||
    registry.schemaVersion !== 1 ||
    registry.authority !== "observation_only" ||
    !Array.isArray(registry.gates) ||
    !Array.isArray(registry.evidence)
  ) {
    diagnostics.push({
      code: "invalid_gate_registry_shape",
      file: "generated/deferred-gates.json",
      detail: "deferred_gate_registry_shape_is_invalid"
    });
  }
  for (const gate of registry.gates) {
    if (!isRecord(gate) || typeof gate.id !== "string") {
      diagnostics.push({
        code: "invalid_gate_shape",
        file: "generated/deferred-gates.json",
        detail: "deferred_gate_definition_is_invalid"
      });
      continue;
    }
    actualIds.push(gate.id);
    const expectedGate = DEFERRED_GATES.find((candidate) => candidate.id === gate.id);
    if (
      !isValidDeferredGateShape(gate) ||
      !expectedGate ||
      stableJson(gate) !== stableJson(expectedGate)
    ) {
      diagnostics.push({
        code: "invalid_gate_shape",
        file: "generated/deferred-gates.json",
        detail: `deferred_gate_definition_changed:${gate.id}`
      });
    }
    if (!expectedIds.has(gate.id as (typeof DEFERRED_GATES)[number]["id"])) {
      diagnostics.push({
        code: "orphan_gate",
        file: "generated/deferred-gates.json",
        detail: `orphan_gate:${gate.id}`
      });
    }
    if (gate.status !== "deferred") {
      diagnostics.push({
        code: "deferred_gate_promotion",
        file: "generated/deferred-gates.json",
        detail: `gate_must_remain_deferred:${gate.id}`
      });
    }
  }
  const seen = new Set<string>();
  for (const id of actualIds) {
    if (seen.has(id)) {
      diagnostics.push({
        code: "duplicate_gate",
        file: "generated/deferred-gates.json",
        detail: `duplicate_gate:${id}`
      });
    }
    seen.add(id);
  }
  for (const id of expectedIds) {
    if (!seen.has(id)) {
      diagnostics.push({
        code: "missing_gate",
        file: "generated/deferred-gates.json",
        detail: `missing_gate:${id}`
      });
    }
  }

  for (const declaration of declarations) {
    if (new Set(declaration.deferredGateIds).size !== declaration.deferredGateIds.length) {
      diagnostics.push({
        code: "duplicate_deferred_gate_reference",
        file: declaration.ownerModule,
        detail: `duplicate_deferred_gate_reference:${declaration.id}`
      });
    }
    const references = new Set(declaration.deferredGateIds);
    for (const id of expectedIds) {
      if (!references.has(id)) {
        diagnostics.push({
          code: "missing_deferred_gate_reference",
          file: declaration.ownerModule,
          detail: `missing_deferred_gate_reference:${declaration.id}:${id}`
        });
      }
    }
    for (const id of references) {
      if (!expectedIds.has(id as (typeof DEFERRED_GATES)[number]["id"])) {
        diagnostics.push({
          code: "orphan_deferred_gate_reference",
          file: declaration.ownerModule,
          detail: `orphan_deferred_gate_reference:${declaration.id}:${id}`
        });
      }
    }
  }

  for (const claim of registry.evidence) {
    if (!isRecord(claim)) {
      diagnostics.push({
        code: "invented_evidence",
        file: "generated/deferred-gates.json",
        detail: "evidence_claim_is_not_an_object"
      });
      continue;
    }
    diagnostics.push({
      code: "invented_evidence",
      file: "generated/deferred-gates.json",
      detail: `r0_evidence_is_closed:${String(claim.id)}`
    });
    if (typeof claim.gateId !== "string" || !expectedIds.has(claim.gateId as never)) {
      diagnostics.push({
        code: "orphan_evidence_gate",
        file: "generated/deferred-gates.json",
        detail: `orphan_evidence_gate:${String(claim.gateId)}`
      });
    }
    if (claim.status !== "passed" && claim.status !== "failed") {
      diagnostics.push({
        code: "unsupported_evidence_status",
        file: "generated/deferred-gates.json",
        detail: `unsupported_evidence_status:${String(claim.status)}`
      });
    }
    if (claim.strength !== "hostile_tested") {
      diagnostics.push({
        code: "unsupported_evidence_strength",
        file: "generated/deferred-gates.json",
        detail: `unsupported_evidence_strength:${String(claim.strength)}`
      });
    }
    if (typeof claim.fingerprintId !== "string" || !fingerprintIds.has(claim.fingerprintId)) {
      diagnostics.push({
        code: "orphan_evidence_fingerprint",
        file: "generated/deferred-gates.json",
        detail: `orphan_evidence_fingerprint:${String(claim.fingerprintId)}`
      });
    }
    if (
      !Array.isArray(claim.outcomes) ||
      claim.outcomes.length === 0 ||
      claim.outcomes.some(
        (outcome) =>
          !isRecord(outcome) ||
          typeof outcome.variant !== "string" ||
          outcome.variant === "*" ||
          (outcome.result !== "passed" && outcome.result !== "failed")
      )
    ) {
      diagnostics.push({
        code: "collapsed_evidence_outcome",
        file: "generated/deferred-gates.json",
        detail: `evidence_outcomes_not_variant_specific:${String(claim.id)}`
      });
    }
  }
  return diagnostics;
}

const deferredSemanticAxes = new Set([
  "carrier_authority_guard",
  "caller_controlled_scope",
  "service_operation_linkage",
  "permission_commit_reauthorization",
  "tenant_relationship_invariants",
  "model_reads_writes_effects",
  "variant_specific_outcomes",
  "worker_loop_claim_failure_containment",
  "browser_immutable_binding_stale_behavior",
  "executable_evidence_strength"
]);

function isValidDeferredGateShape(gate: Record<string, unknown>): boolean {
  return (
    Object.keys(gate).sort().join(",") ===
      "blockedAxes,dependencyPhase,exitCriteria,id,rationale,status" &&
    isNonBlankString(gate.id) &&
    gate.status === "deferred" &&
    isNonBlankString(gate.rationale) &&
    (gate.dependencyPhase === "R2" ||
      gate.dependencyPhase === "R3" ||
      gate.dependencyPhase === "R4") &&
    Array.isArray(gate.blockedAxes) &&
    gate.blockedAxes.length > 0 &&
    gate.blockedAxes.every(
      (axis) => isNonBlankString(axis) && deferredSemanticAxes.has(axis)
    ) &&
    new Set(gate.blockedAxes).size === gate.blockedAxes.length &&
    isNonBlankString(gate.exitCriteria)
  );
}

function discoverCommandVariants(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  ownerModule: string
): StructuralDiscovery {
  const observations: StructuralObservation[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const functions = collectCommandFunctions(sourceFile);
  const functionsByName = new Map(functions.map((entry) => [entry.name, entry]));
  const callableAliases = collectStaticCallableAliases(sourceFile, functionsByName);
  const rootedDiscovery = findPackageArgumentRootedFunctions(
    checker,
    sourceFile,
    functionsByName,
    callableAliases,
    ownerModule
  );
  const rootedFunctions = rootedDiscovery.rooted;
  diagnostics.push(...rootedDiscovery.diagnostics);
  diagnostics.push(...discoverUnsupportedClassPackageArgumentFlow(
    sourceFile,
    ownerModule,
    rootedDiscovery.moduleArgumentFlow
  ));
  const topLevelDispatch = discoverTopLevelPackageArgumentDispatch(
    sourceFile,
    ownerModule,
    rootedDiscovery.moduleArgumentFlow
  );
  observations.push(...topLevelDispatch.observations);
  diagnostics.push(...topLevelDispatch.diagnostics);
  const topLevelTables = discoverTopLevelPackageArgumentTables(
    sourceFile,
    ownerModule,
    rootedDiscovery.moduleArgumentFlow
  );
  observations.push(...topLevelTables.observations);
  diagnostics.push(...topLevelTables.diagnostics);
  diagnostics.push(...discoverUnclassifiedPackageArgumentRoots(
    sourceFile,
    ownerModule,
    rootedDiscovery.moduleArgumentFlow
  ));
  for (const parser of functions) {
    const parserName = parser.name;
    const parameterRoots = rootedFunctions.get(parserName);
    if (!parameterRoots) continue;
    const argumentFlow = traceCommandArgumentFlow(checker, parser, parameterRoots);
    if (argumentFlow.unsupportedBindingPatterns.size > 0) {
      diagnostics.push({
        code: "unsupported_package_command_variant",
        file: ownerModule,
        detail: "package_argument_binding_pattern_is_not_static"
      });
    }
    const discriminators = argumentFlow.discriminators;
    const expectsReturnedVariants = containsReturnedKindProperty(parser.body);
    const seenVariants = new Set<string>();
    let sawDispatch = false;
    let unsupportedLookup = false;
    let unsupportedDispatcher = false;
    const addVariant = (variant: string, anchor: ts.Node) => {
      if (seenVariants.has(variant)) return;
      seenVariants.add(variant);
      observations.push({
        kind: "command_variant",
        ownerModule,
        symbol: variant,
        target: `${ownerModule}#${parserName}:${variant}`,
        anchorFile: ownerModule,
        anchorStart: anchor.getStart(sourceFile),
        anchorEnd: anchor.getEnd()
      });
    };
    const visit = (node: ts.Node) => {
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
      ) {
        const leftIsDiscriminator =
          ts.isIdentifier(node.left) && discriminators.has(node.left.text);
        const rightIsDiscriminator =
          ts.isIdentifier(node.right) && discriminators.has(node.right.text);
        if (leftIsDiscriminator || rightIsDiscriminator) {
          const candidate = leftIsDiscriminator ? node.right : node.left;
          const literal = resolveStaticCommandLiteral(sourceFile, candidate);
          if (literal && !literal.value.startsWith("-")) {
            sawDispatch = true;
            addVariant(literal.value, node);
          } else if (!literal) {
            sawDispatch = true;
            diagnostics.push({
              code: "unsupported_package_command_variant",
              file: ownerModule,
              detail: "command_variant_is_not_a_string_literal"
            });
          }
        }
      }
      if (
        ts.isSwitchStatement(node) &&
        ts.isIdentifier(node.expression) &&
        discriminators.has(node.expression.text)
      ) {
        for (const clause of node.caseBlock.clauses) {
          if (ts.isDefaultClause(clause)) continue;
          const literal = resolveStaticCommandLiteral(sourceFile, clause.expression);
          if (literal && !literal.value.startsWith("-")) {
            sawDispatch = true;
            addVariant(literal.value, clause);
          } else if (!literal) {
            sawDispatch = true;
            diagnostics.push({
              code: "unsupported_package_command_variant",
              file: ownerModule,
              detail: "switch_command_variant_is_not_a_string_literal"
            });
          }
        }
        return;
      }
      if (ts.isElementAccessExpression(node) && node.argumentExpression) {
        const argument = unwrapParentheses(node.argumentExpression);
        const directDiscriminator =
          ts.isIdentifier(argument) && discriminators.has(argument.text);
        const computedDiscriminator = !directDiscriminator &&
          nodeContainsIdentifier(argument, discriminators);
        if (directDiscriminator || computedDiscriminator) {
          sawDispatch = true;
          if (computedDiscriminator) {
            unsupportedLookup = true;
            diagnostics.push({
              code: "unsupported_package_command_variant",
              file: ownerModule,
              detail: `command_variant_lookup_key_is_computed:${parserName}`
            });
          } else {
            const lookup = resolveStaticCommandLookupTable(
              parser.body,
              node.expression
            );
            if (!lookup.ok) {
              unsupportedLookup = true;
              diagnostics.push({
                code: "unsupported_package_command_variant",
                file: ownerModule,
                detail: `command_variant_lookup_table_is_not_static:${parserName}`
              });
            } else {
              for (const variant of lookup.variants) addVariant(variant.value, variant.anchor);
            }
          }
          return;
        }
      }
      const condition = ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)
        ? node.expression
        : ts.isConditionalExpression(node)
          ? node.condition
          : ts.isForStatement(node)
            ? node.condition
            : undefined;
      if (
        condition &&
        nodeContainsIdentifier(condition, discriminators) &&
        !conditionUsesOnlyCommandComparisons(condition, discriminators)
      ) {
        unsupportedDispatcher = true;
      }
      if (
        ts.isCallExpression(node) &&
        node.arguments.some((argument) =>
          nodeContainsIdentifier(argument, discriminators) ||
          nodeContainsIdentifier(argument, argumentFlow.sequences)
        ) &&
        (!ts.isIdentifier(node.expression) ||
          !resolveStaticCallableName(
            node.expression.text,
            functionsByName,
            callableAliases
          ))
      ) {
        unsupportedDispatcher = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(parser.body, visit);
    if (unsupportedDispatcher) {
      diagnostics.push({
        code: "unsupported_package_command_variant",
        file: ownerModule,
        detail: `command_variant_dispatcher_shape_unsupported:${parserName}`
      });
    }
    if (
      (expectsReturnedVariants || sawDispatch) &&
      seenVariants.size === 0 &&
      !unsupportedLookup
    ) {
      diagnostics.push({
        code: "unsupported_package_command_variant",
        file: ownerModule,
        detail: `command_variant_parser_shape_unsupported:${parserName}`
      });
    }
  }
  return { observations, diagnostics };
}

function discoverUnsupportedClassPackageArgumentFlow(
  sourceFile: ts.SourceFile,
  ownerModule: string,
  flow: CommandArgumentFlow
): readonly OperationRegistryDiagnostic[] {
  const classNames = new Set<string>();
  const collectClasses = (node: ts.Node) => {
    if (ts.isClassDeclaration(node) && node.name) classNames.add(node.name.text);
    ts.forEachChild(node, collectClasses);
  };
  ts.forEachChild(sourceFile, collectClasses);
  const carriesPackageArgumentRoot = (expression: ts.Expression): boolean =>
    commandRootKindInExpression(expression, flow) !== null;
  const containsThis = (node: ts.Node): boolean => {
    let found = false;
    const visit = (current: ts.Node) => {
      if (current.kind === ts.SyntaxKind.ThisKeyword) {
        found = true;
        return;
      }
      if (!found) ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  };
  const isClassFieldTarget = (expression: ts.Expression): boolean => {
    const current = unwrapStaticExpression(expression);
    if (
      !ts.isPropertyAccessExpression(current) &&
      !ts.isElementAccessExpression(current)
    ) {
      return false;
    }
    let root = unwrapStaticExpression(current.expression);
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
      root = unwrapStaticExpression(root.expression);
    }
    return root.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isIdentifier(root) && classNames.has(root.text));
  };
  const classMemberChainReachesArgv = (expression: ts.Expression): boolean => {
    let current = unwrapStaticExpression(expression);
    let sawArgv = false;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      if (
        (ts.isPropertyAccessExpression(current) && current.name.text === "argv") ||
        (ts.isElementAccessExpression(current) &&
          current.argumentExpression !== undefined &&
          resolveStaticCommandLiteral(
            sourceFile,
            current.argumentExpression
          )?.value === "argv")
      ) {
        sawArgv = true;
      }
      current = unwrapStaticExpression(current.expression);
    }
    return sawArgv && (
      current.kind === ts.SyntaxKind.ThisKeyword ||
      (ts.isIdentifier(current) && classNames.has(current.text))
    );
  };
  let unsupported = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyDeclaration(node) &&
      node.initializer &&
      carriesPackageArgumentRoot(node.initializer)
    ) {
      unsupported = true;
      return;
    }
    if (
      ts.isParameter(node) &&
      node.initializer &&
      node.modifiers?.some((modifier) =>
        [
          ts.SyntaxKind.PublicKeyword,
          ts.SyntaxKind.PrivateKeyword,
          ts.SyntaxKind.ProtectedKeyword,
          ts.SyntaxKind.ReadonlyKeyword
        ].includes(modifier.kind)
      ) &&
      carriesPackageArgumentRoot(node.initializer)
    ) {
      unsupported = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isClassFieldTarget(node.left) &&
      carriesPackageArgumentRoot(node.right)
    ) {
      unsupported = true;
      return;
    }
    if (
      ts.isExpression(node) &&
      classMemberChainReachesArgv(node)
    ) {
      unsupported = true;
      return;
    }
    if (
      ts.isCallExpression(node) &&
      containsThis(node.expression) &&
      node.arguments.some(carriesPackageArgumentRoot)
    ) {
      unsupported = true;
      return;
    }
    if (!unsupported) ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return unsupported
    ? [{
        code: "unsupported_package_command_variant",
        file: ownerModule,
        detail: "package_argument_class_field_or_this_flow_is_not_static"
      }]
    : [];
}

function conditionUsesOnlyCommandComparisons(
  condition: ts.Expression,
  discriminators: ReadonlySet<string>
): boolean {
  let foundComparison = false;
  let unsupportedUse = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
    ) {
      const leftIsDiscriminator =
        ts.isIdentifier(node.left) && discriminators.has(node.left.text);
      const rightIsDiscriminator =
        ts.isIdentifier(node.right) && discriminators.has(node.right.text);
      if (leftIsDiscriminator || rightIsDiscriminator) {
        foundComparison = true;
        const candidate = leftIsDiscriminator ? node.right : node.left;
        ts.forEachChild(candidate, visit);
        return;
      }
    }
    if (ts.isIdentifier(node) && discriminators.has(node.text)) {
      unsupportedUse = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return foundComparison && !unsupportedUse;
}

type CommandFunction = {
  readonly name: string;
  readonly body: ts.Block;
  readonly parameters: readonly ts.ParameterDeclaration[];
};

type CommandArgumentRootKind =
  | "process"
  | "raw_sequence"
  | "sequence"
  | "discriminator";
type CommandFunctionParameterRoots = ReadonlyMap<
  number,
  ReadonlySet<CommandArgumentRootKind>
>;

function collectCommandFunctions(sourceFile: ts.SourceFile): readonly CommandFunction[] {
  const output: CommandFunction[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      output.push({
        name: statement.name.text,
        body: statement.body,
        parameters: statement.parameters
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrapStaticExpression(declaration.initializer);
      if (
        (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
        ts.isBlock(initializer.body)
      ) {
        output.push({
          name: declaration.name.text,
          body: initializer.body,
          parameters: initializer.parameters
        });
      }
    }
  }
  return output;
}

function findPackageArgumentRootedFunctions(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  functionsByName: ReadonlyMap<string, CommandFunction>,
  callableAliases: ReadonlyMap<string, string>,
  ownerModule: string
): {
  readonly rooted: ReadonlyMap<string, CommandFunctionParameterRoots>;
  readonly moduleArgumentFlow: CommandArgumentFlow;
  readonly diagnostics: readonly OperationRegistryDiagnostic[];
} {
  const rooted = new Map<
    string,
    Map<number, Set<CommandArgumentRootKind>>
  >();
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const addRoot = (
    functionName: string,
    parameterIndex: number,
    kind: CommandArgumentRootKind
  ): boolean => {
    const entry = functionsByName.get(functionName);
    if (!entry?.parameters[parameterIndex]) return false;
    let parameters = rooted.get(functionName);
    if (!parameters) {
      parameters = new Map();
      rooted.set(functionName, parameters);
    }
    let kinds = parameters.get(parameterIndex);
    if (!kinds) {
      kinds = new Set();
      parameters.set(parameterIndex, kinds);
    }
    const before = kinds.size;
    kinds.add(kind);
    return kinds.size !== before;
  };

  const moduleArgumentFlow = collectModuleArgumentFlow(checker, sourceFile);
  for (const [functionName, entry] of functionsByName) {
    const directFlow = traceCommandArgumentFlow(checker, entry, new Map());
    if (
      directFlow.discriminators.size > 0 ||
      directFlow.sequences.size > 0 ||
      directFlow.unsupportedBindingPatterns.size > 0
    ) {
      rooted.set(functionName, new Map());
    }
  }
  const visitInitial = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const calleeName = ts.isIdentifier(node.expression)
        ? resolveStaticCallableName(
            node.expression.text,
            functionsByName,
            callableAliases
          )
        : null;
      let reportedUnresolved = false;
      node.arguments.forEach((argument, index) => {
        const kind = commandRootKindInExpression(argument, moduleArgumentFlow);
        if (
          kind === "process" ||
          kind === "raw_sequence" ||
          kind === "sequence" ||
          kind === "discriminator"
        ) {
          if (calleeName) {
            addRoot(calleeName, index, kind);
          } else if (ts.isIdentifier(node.expression) && !reportedUnresolved) {
            diagnostics.push({
              code: "unsupported_package_command_variant",
              file: ownerModule,
              detail: `package_argument_call_target_unresolved:${
                ts.isIdentifier(node.expression) ? node.expression.text : "computed"
              }`
            });
            reportedUnresolved = true;
          }
        }
      });
    }
    ts.forEachChild(node, visitInitial);
  };
  ts.forEachChild(sourceFile, visitInitial);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, parameterRoots] of [...rooted]) {
      const entry = functionsByName.get(name);
      if (!entry) continue;
      const flow = traceCommandArgumentFlow(checker, entry, parameterRoots);
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression)
        ) {
          const calleeName = resolveStaticCallableName(
            node.expression.text,
            functionsByName,
            callableAliases
          );
          if (calleeName) {
            node.arguments.forEach((argument, index) => {
              const kind = commandArgumentExpressionKind(argument, flow);
              if (kind && addRoot(calleeName, index, kind)) changed = true;
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(entry.body, visit);
    }
  }
  return { rooted, moduleArgumentFlow, diagnostics };
}

function collectStaticCallableAliases(
  sourceFile: ts.SourceFile,
  functionsByName: ReadonlyMap<string, CommandFunction>
): ReadonlyMap<string, string> {
  const candidateValues = new Map<string, string[]>();
  const addCandidate = (name: string, value: string) => {
    const values = candidateValues.get(name) ?? [];
    values.push(value);
    candidateValues.set(name, values);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      const initializer = node.initializer
        ? unwrapStaticExpression(node.initializer)
        : null;
      if (
        ts.isIdentifier(node.name) &&
        initializer &&
        ts.isIdentifier(initializer)
      ) {
        addCandidate(node.name.text, initializer.text);
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const value = unwrapStaticExpression(node.right);
      if (ts.isIdentifier(value)) {
        addCandidate(node.left.text, value.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  const aliases = new Map<string, string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, values] of candidateValues) {
      if (values.length !== 1 || aliases.has(name)) continue;
      const value = values[0];
      const target = functionsByName.has(value) ? value : aliases.get(value);
      if (target) {
        aliases.set(name, target);
        changed = true;
      }
    }
  }
  return aliases;
}

function resolveStaticCallableName(
  name: string,
  functionsByName: ReadonlyMap<string, CommandFunction>,
  aliases: ReadonlyMap<string, string>
): string | null {
  if (functionsByName.has(name)) return name;
  return aliases.get(name) ?? null;
}

function collectModuleArgumentFlow(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile
): CommandArgumentFlow {
  const sequences = new Set<string>();
  const rawSequences = new Set<string>();
  const discriminators = new Set<string>();
  const processObjects = new Set<string>(["process"]);
  const unsupportedBindingPatterns = new Set<number>();
  const flow = {
    checker,
    sourceFile,
    sequences,
    rawSequences,
    discriminators,
    processObjects,
    unsupportedBindingPatterns
  };
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node) => {
      if (
        node !== sourceFile &&
        (ts.isFunctionDeclaration(node) ||
          ts.isFunctionExpression(node) ||
          ts.isArrowFunction(node) ||
          ts.isMethodDeclaration(node))
      ) {
        return;
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (applyCommandFlowAssignment(node.name, node.initializer, flow)) changed = true;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        if (applyCommandFlowAssignment(node.left, node.right, flow)) changed = true;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sourceFile, visit);
  }
  return flow;
}

function applyCommandFlowAssignment(
  target: ts.BindingName | ts.Expression,
  value: ts.Expression,
  flow: CommandArgumentFlow
): boolean {
  const initializer = unwrapStaticExpression(value);
  let changed = !ts.isIdentifier(target)
    ? applyStaticPackageRootBindingPattern(target, value, flow)
    : false;
  const add = (set: Set<string>, name: string) => {
    if (set.has(name)) return;
    set.add(name);
    changed = true;
  };
  if (ts.isIdentifier(target)) {
    if (isProcessObjectExpression(initializer, flow)) {
      add(flow.processObjects as Set<string>, target.text);
    }
    const kind = commandRootKindInExpression(value, flow);
    if (kind === "sequence") add(flow.sequences as Set<string>, target.text);
    if (kind === "discriminator") add(flow.discriminators as Set<string>, target.text);
    if (isProcessArgvExpression(initializer, flow)) {
      add(flow.rawSequences as Set<string>, target.text);
    }
    return changed;
  }
  if (
    (ts.isObjectBindingPattern(target) || ts.isObjectLiteralExpression(target)) &&
    isProcessObjectExpression(initializer, flow)
  ) {
    return applyProcessObjectBindingPattern(target, flow) || changed;
  }
  const kind = commandRootKindInExpression(value, flow);
  if (
    kind === "sequence" &&
    (ts.isArrayBindingPattern(target) || ts.isArrayLiteralExpression(target))
  ) {
    const raw = isProcessArgvExpression(initializer, flow) ||
      (ts.isIdentifier(initializer) && flow.rawSequences.has(initializer.text));
    changed = applyCommandSequenceBindingPattern(
      target,
      raw ? "raw" : "command",
      flow
    ) || changed;
  }
  return changed;
}

function applyStaticPackageRootBindingPattern(
  target: ts.BindingName | ts.Expression,
  value: ts.Expression,
  flow: CommandArgumentFlow
): boolean {
  let changed = false;
  const add = (set: Set<string>, name: string) => {
    if (set.has(name)) return;
    set.add(name);
    changed = true;
  };
  const rootOptions: StaticRootFlowOptions = {
    identifyRoot: (identifier) =>
      flow.processObjects.has(identifier.text) ? "process" : null
  };
  const sourceRoot = resolveStaticRootFlow(
    flow.checker,
    value,
    rootOptions
  );
  if (!packageStaticResolutionMayCarryArguments(sourceRoot)) return false;
  const bind = (
    current: ts.BindingName | ts.Expression,
    path: readonly StaticRootFlowSegment[]
  ) => {
    const unwrapped = ts.isExpression(current)
      ? unwrapStaticExpression(current)
      : current;
    if (ts.isIdentifier(unwrapped)) {
      const resolution = resolveStaticRootFlow(
        flow.checker,
        value,
        rootOptions,
        path
      );
      if (
        resolution.kind === "resolved" &&
        resolution.root === "process" &&
        resolution.path.length === 0
      ) {
        add(flow.processObjects as Set<string>, unwrapped.text);
        return;
      }
      const kind = packageCommandKindFromStaticRoot(resolution);
      if (kind === "sequence") add(flow.sequences as Set<string>, unwrapped.text);
      if (kind === "discriminator") {
        add(flow.discriminators as Set<string>, unwrapped.text);
      }
      if (kind === "ambiguous") {
        flow.unsupportedBindingPatterns.add(unwrapped.getStart());
      }
      return;
    }
    if (ts.isArrayBindingPattern(unwrapped) || ts.isArrayLiteralExpression(unwrapped)) {
      unwrapped.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return;
        const rest = (ts.isBindingElement(element) && Boolean(element.dotDotDotToken)) ||
          ts.isSpreadElement(element);
        const child = ts.isBindingElement(element)
          ? element.name
          : ts.isSpreadElement(element)
            ? element.expression
            : element;
        bind(
          child,
          [
            ...path,
            rest
              ? { kind: "slice" as const, start: index }
              : { kind: "property" as const, key: String(index) }
          ]
        );
      });
      return;
    }
    if (ts.isObjectBindingPattern(unwrapped) || ts.isObjectLiteralExpression(unwrapped)) {
      const properties = ts.isObjectBindingPattern(unwrapped)
        ? unwrapped.elements
        : unwrapped.properties;
      for (const property of properties) {
        if (ts.isBindingElement(property)) {
          if (property.dotDotDotToken) {
            flow.unsupportedBindingPatterns.add(property.getStart());
            continue;
          }
          const key = staticCommandBindingPropertyName(
            unwrapped.getSourceFile(),
            property.propertyName ??
              (ts.isIdentifier(property.name) ? property.name : undefined)
          );
          if (key === null) {
            flow.unsupportedBindingPatterns.add(property.getStart());
            continue;
          }
          bind(property.name, [...path, { kind: "property", key }]);
          continue;
        }
        if (ts.isSpreadAssignment(property)) {
          flow.unsupportedBindingPatterns.add(property.getStart());
          continue;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          bind(property.name, [
            ...path,
            { kind: "property", key: property.name.text }
          ]);
          continue;
        }
        if (ts.isPropertyAssignment(property)) {
          const key = staticCommandBindingPropertyName(
            unwrapped.getSourceFile(),
            property.name
          );
          if (key === null) {
            flow.unsupportedBindingPatterns.add(property.getStart());
            continue;
          }
          bind(property.initializer, [...path, { kind: "property", key }]);
        }
      }
      return;
    }
    flow.unsupportedBindingPatterns.add(unwrapped.getStart());
  };
  bind(target, []);
  return changed;
}

function packageStaticResolutionMayCarryArguments(
  resolution: StaticRootFlowResolution
): boolean {
  if (resolution.kind === "none" || resolution.root !== "process") return false;
  if (!resolution.path || resolution.path.length === 0) return true;
  const first = resolution.path[0];
  return first.kind === "property" && first.key === "argv";
}

function applyProcessObjectBindingPattern(
  target: ts.ObjectBindingPattern | ts.ObjectLiteralExpression,
  flow: CommandArgumentFlow
): boolean {
  let changed = false;
  const add = (set: Set<string>, name: string) => {
    if (set.has(name)) return;
    set.add(name);
    changed = true;
  };
  if (ts.isObjectBindingPattern(target)) {
    for (const element of target.elements) {
      if (element.dotDotDotToken) {
        flow.unsupportedBindingPatterns.add(element.getStart());
        continue;
      }
      const key = staticCommandBindingPropertyName(
        target.getSourceFile(),
        element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined)
      );
      if (key === null) {
        flow.unsupportedBindingPatterns.add(element.getStart());
        continue;
      }
      if (key !== "argv") continue;
      if (ts.isIdentifier(element.name)) {
        add(flow.sequences as Set<string>, element.name.text);
        add(flow.rawSequences as Set<string>, element.name.text);
      } else {
        changed = applyCommandSequenceBindingPattern(element.name, "raw", flow) || changed;
      }
    }
    return changed;
  }
  for (const property of target.properties) {
    if (ts.isSpreadAssignment(property)) {
      flow.unsupportedBindingPatterns.add(property.getStart());
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      if (property.name.text === "argv") {
        add(flow.sequences as Set<string>, property.name.text);
        add(flow.rawSequences as Set<string>, property.name.text);
      }
      continue;
    }
    if (!ts.isPropertyAssignment(property)) {
      flow.unsupportedBindingPatterns.add(property.getStart());
      continue;
    }
    const key = staticCommandBindingPropertyName(target.getSourceFile(), property.name);
    if (key === null) {
      flow.unsupportedBindingPatterns.add(property.getStart());
      continue;
    }
    if (key !== "argv") continue;
    const assignmentTarget = unwrapStaticExpression(property.initializer);
    if (ts.isIdentifier(assignmentTarget)) {
      add(flow.sequences as Set<string>, assignmentTarget.text);
      add(flow.rawSequences as Set<string>, assignmentTarget.text);
    } else if (
      ts.isArrayLiteralExpression(assignmentTarget) ||
      ts.isObjectLiteralExpression(assignmentTarget)
    ) {
      changed = applyCommandSequenceBindingPattern(
        assignmentTarget,
        "raw",
        flow
      ) || changed;
    } else {
      flow.unsupportedBindingPatterns.add(property.getStart());
    }
  }
  return changed;
}

function applyCommandSequenceBindingPattern(
  target:
    | ts.ArrayBindingPattern
    | ts.ArrayLiteralExpression
    | ts.ObjectBindingPattern
    | ts.ObjectLiteralExpression,
  source: "raw" | "command",
  flow: CommandArgumentFlow
): boolean {
  let changed = false;
  const commandIndex = source === "raw" ? 2 : 0;
  const add = (set: Set<string>, name: string) => {
    if (set.has(name)) return;
    set.add(name);
    changed = true;
  };
  const entries: Array<{
    readonly index: number | null;
    readonly node: ts.Node;
    readonly rest: boolean;
    readonly bindingTarget: ts.BindingName | ts.Expression;
  }> = [];
  if (ts.isArrayBindingPattern(target) || ts.isArrayLiteralExpression(target)) {
    for (let index = 0; index < target.elements.length; index += 1) {
      const element = target.elements[index];
      if (ts.isOmittedExpression(element)) continue;
      entries.push({
        index,
        node: element,
        rest: (ts.isBindingElement(element) && Boolean(element.dotDotDotToken)) ||
          ts.isSpreadElement(element),
        bindingTarget: ts.isBindingElement(element)
          ? element.name
          : ts.isSpreadElement(element)
            ? unwrapStaticExpression(element.expression)
            : unwrapStaticExpression(element)
      });
    }
  } else {
    const properties = ts.isObjectBindingPattern(target)
      ? target.elements
      : target.properties;
    for (const property of properties) {
      if (ts.isBindingElement(property)) {
        if (property.dotDotDotToken) {
          flow.unsupportedBindingPatterns.add(property.getStart());
          continue;
        }
        const key = staticCommandBindingPropertyName(
          target.getSourceFile(),
          property.propertyName ??
            (ts.isIdentifier(property.name) ? property.name : undefined)
        );
        entries.push({
          index: key !== null && /^\d+$/.test(key) ? Number(key) : null,
          node: property,
          rest: false,
          bindingTarget: property.name
        });
        continue;
      }
      if (ts.isSpreadAssignment(property)) {
        flow.unsupportedBindingPatterns.add(property.getStart());
        continue;
      }
      if (ts.isShorthandPropertyAssignment(property)) {
        entries.push({
          index: /^\d+$/.test(property.name.text) ? Number(property.name.text) : null,
          node: property,
          rest: false,
          bindingTarget: property.name
        });
        continue;
      }
      if (ts.isPropertyAssignment(property)) {
        const key = staticCommandBindingPropertyName(target.getSourceFile(), property.name);
        entries.push({
          index: key !== null && /^\d+$/.test(key) ? Number(key) : null,
          node: property,
          rest: false,
          bindingTarget: unwrapStaticExpression(property.initializer)
        });
        continue;
      }
      flow.unsupportedBindingPatterns.add(property.getStart());
    }
  }
  for (const entry of entries) {
    const { index, node: element, rest, bindingTarget } = entry;
    if (index === null) {
      flow.unsupportedBindingPatterns.add(element.getStart());
      continue;
    }
    if (rest && ts.isIdentifier(bindingTarget)) {
      if (index === commandIndex) {
        add(flow.sequences as Set<string>, bindingTarget.text);
      } else if (source === "command" && index > commandIndex) {
        add(flow.sequences as Set<string>, bindingTarget.text);
      } else if (source === "raw" && index === 0) {
        add(flow.sequences as Set<string>, bindingTarget.text);
        add(flow.rawSequences as Set<string>, bindingTarget.text);
      } else if (index < commandIndex) {
        flow.unsupportedBindingPatterns.add(element.getStart());
      }
      continue;
    }
    if (!rest && index === commandIndex && ts.isIdentifier(bindingTarget)) {
      add(flow.discriminators as Set<string>, bindingTarget.text);
      continue;
    }
    if (index >= commandIndex) {
      flow.unsupportedBindingPatterns.add(element.getStart());
    }
  }
  return changed;
}

function staticCommandBindingPropertyName(
  root: ts.Node,
  name: ts.PropertyName | undefined
): string | null {
  if (!name) return null;
  if (!ts.isComputedPropertyName(name)) return propertyName(name);
  return resolveStaticCommandLiteral(root, name.expression)?.value ?? null;
}

type CommandRootExpressionKind = CommandArgumentRootKind | "ambiguous" | null;

function commandRootKindInExpression(
  expression: ts.Expression,
  flow: CommandArgumentFlow
): CommandRootExpressionKind {
  const current = unwrapStaticExpression(expression);
  if (ts.isIdentifier(current)) {
    if (flow.discriminators.has(current.text)) return "discriminator";
    if (flow.sequences.has(current.text)) return "sequence";
  }
  const staticRoot = resolveStaticRootFlow(
    flow.checker,
    current,
    {
      identifyRoot: (identifier) =>
        flow.processObjects.has(identifier.text) ? "process" : null
    }
  );
  const staticKind = packageCommandKindFromStaticRoot(staticRoot);
  if (staticKind) return staticKind;
  if (isProcessArgvExpression(current, flow)) return "sequence";
  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === "slice" &&
    (isProcessArgvExpression(unwrapStaticExpression(current.expression.expression), flow) ||
      (ts.isIdentifier(unwrapStaticExpression(current.expression.expression)) &&
        flow.rawSequences.has(
          (unwrapStaticExpression(current.expression.expression) as ts.Identifier).text
        )))
  ) {
    const start = current.arguments[0]
      ? unwrapStaticExpression(current.arguments[0])
      : null;
    return start && ts.isNumericLiteral(start) && Number(start.text) === 2
      ? "sequence"
      : "ambiguous";
  }
  if (
    ts.isElementAccessExpression(current) &&
    isProcessArgvExpression(unwrapStaticExpression(current.expression), flow)
  ) {
    const index = current.argumentExpression
      ? unwrapStaticExpression(current.argumentExpression)
      : null;
    if (index && ts.isNumericLiteral(index)) {
      return Number(index.text) === 2 ? "discriminator" : null;
    }
    return "ambiguous";
  }
  if (ts.isElementAccessExpression(current) && current.argumentExpression) {
    const index = unwrapStaticExpression(current.argumentExpression);
    const rawAlias = unwrapStaticExpression(current.expression);
    if (ts.isIdentifier(rawAlias) && flow.rawSequences.has(rawAlias.text)) {
      return ts.isNumericLiteral(index) && Number(index.text) === 2
        ? "discriminator"
        : "ambiguous";
    }
    const sourceKind = commandRootKindInExpression(current.expression, flow);
    if (sourceKind === "sequence" && ts.isNumericLiteral(index)) {
      return Number(index.text) === 0 ? "discriminator" : "ambiguous";
    }
    if (sourceKind) return "ambiguous";
  }
  if (ts.isCallExpression(current)) return null;
  const kinds = new Set<Exclude<CommandRootExpressionKind, null>>();
  const visit = (node: ts.Node) => {
    if (node !== current && ts.isExpression(node)) {
      const kind = commandRootKindInExpression(node, flow);
      if (kind) {
        kinds.add(kind);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(current, visit);
  if (
    kinds.size > 0 &&
    (ts.isObjectLiteralExpression(current) || ts.isArrayLiteralExpression(current))
  ) {
    return "ambiguous";
  }
  if (kinds.has("ambiguous") || kinds.size > 1) return "ambiguous";
  return kinds.values().next().value ?? null;
}

function packageCommandKindFromStaticRoot(
  resolution: StaticRootFlowResolution
): CommandRootExpressionKind {
  if (resolution.kind === "ambiguous") {
    if (resolution.root !== "process" || !resolution.path) return null;
    const argv = resolution.path[0];
    return argv?.kind === "property" && argv.key === "argv"
      ? "ambiguous"
      : null;
  }
  if (resolution.kind !== "resolved" || resolution.root !== "process") return null;
  const path = resolution.path;
  if (path.length === 0) return "process";
  const [argv, ...tail] = path;
  if (argv.kind !== "property" || argv.key !== "argv") return null;
  if (tail.length === 0) return "raw_sequence";
  let sequence = false;
  for (let index = 0; index < tail.length; index += 1) {
    const segment = tail[index];
    if (segment.kind === "slice") {
      if (!sequence && segment.start !== 2) return "ambiguous";
      sequence = true;
      continue;
    }
    if (segment.kind === "object_rest") return "ambiguous";
    if (!sequence) {
      if (/^\d+$/.test(segment.key) && Number(segment.key) < 2) return null;
      return segment.key === "2" && index === tail.length - 1
        ? "discriminator"
        : "ambiguous";
    }
    return segment.key === "0" && index === tail.length - 1
      ? "discriminator"
      : "ambiguous";
  }
  return sequence ? "sequence" : "ambiguous";
}

function isProcessArgvExpression(
  expression: ts.Expression,
  flow: CommandArgumentFlow
): boolean {
  const current = unwrapStaticExpression(expression);
  if (
    ts.isIdentifier(current) &&
    (!isIdentifierValueReference(current) || isWithinStaticAssignmentTarget(current))
  ) {
    return false;
  }
  const root = resolveStaticRootFlow(flow.checker, current, {
    identifyRoot: (identifier) =>
      flow.processObjects.has(identifier.text) ? "process" : null
  });
  if (
    root.kind === "resolved" &&
    root.root === "process" &&
    root.path.length === 1 &&
    root.path[0].kind === "property" &&
    root.path[0].key === "argv"
  ) {
    return true;
  }
  if (ts.isPropertyAccessExpression(current)) {
    return current.name.text === "argv" &&
      ts.isIdentifier(current.expression) &&
      flow.processObjects.has(current.expression.text);
  }
  if (!ts.isElementAccessExpression(current) || !current.argumentExpression) {
    return false;
  }
  const argument = unwrapStaticExpression(current.argumentExpression);
  return (
    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
    argument.text === "argv" &&
    ts.isIdentifier(current.expression) &&
    flow.processObjects.has(current.expression.text)
  );
}

function isProcessObjectExpression(
  expression: ts.Expression,
  flow: CommandArgumentFlow
): boolean {
  const current = unwrapStaticExpression(expression);
  const root = resolveStaticRootFlow(flow.checker, current, {
    identifyRoot: (identifier) =>
      flow.processObjects.has(identifier.text) ? "process" : null
  });
  return root.kind === "resolved" && root.root === "process" && root.path.length === 0;
}

function discoverTopLevelPackageArgumentDispatch(
  sourceFile: ts.SourceFile,
  ownerModule: string,
  flow: CommandArgumentFlow
): StructuralDiscovery {
  const observations: StructuralObservation[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const seen = new Set<string>();
  const addVariant = (variant: string, discriminator: ts.Expression, anchor: ts.Node) => {
    const symbol = ts.isIdentifier(discriminator)
      ? discriminator.text
      : discriminator.getText(sourceFile);
    const key = `${symbol}:${variant}`;
    if (seen.has(key)) return;
    seen.add(key);
    observations.push({
      kind: "command_variant",
      ownerModule,
      symbol: variant,
      target: `${ownerModule}#${symbol}:${variant}`,
      anchorFile: ownerModule,
      anchorStart: anchor.getStart(sourceFile),
      anchorEnd: anchor.getEnd()
    });
  };
  const visit = (node: ts.Node) => {
    if (
      node !== sourceFile &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
    ) {
      const leftKind = commandRootKindInExpression(node.left, flow);
      const rightKind = commandRootKindInExpression(node.right, flow);
      const discriminator = leftKind === "discriminator"
        ? node.left
        : rightKind === "discriminator"
          ? node.right
          : null;
      if (discriminator) {
        const candidate = discriminator === node.left ? node.right : node.left;
        const literal = resolveStaticCommandLiteral(sourceFile, candidate);
        if (literal && !literal.value.startsWith("-")) {
          addVariant(literal.value, discriminator, node);
        } else {
          diagnostics.push({
            code: "unsupported_package_command_variant",
            file: ownerModule,
            detail: "top_level_command_variant_is_not_a_string_literal"
          });
        }
      }
    }
    if (
      ts.isSwitchStatement(node) &&
      commandRootKindInExpression(node.expression, flow) === "discriminator"
    ) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isDefaultClause(clause)) continue;
        const literal = resolveStaticCommandLiteral(sourceFile, clause.expression);
        if (literal && !literal.value.startsWith("-")) {
          addVariant(literal.value, node.expression, clause);
        } else {
          diagnostics.push({
            code: "unsupported_package_command_variant",
            file: ownerModule,
            detail: "top_level_switch_variant_is_not_a_string_literal"
          });
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { observations, diagnostics };
}

function discoverUnclassifiedPackageArgumentRoots(
  sourceFile: ts.SourceFile,
  ownerModule: string,
  flow: CommandArgumentFlow
): readonly OperationRegistryDiagnostic[] {
  const diagnostics: OperationRegistryDiagnostic[] = flow.unsupportedBindingPatterns.size > 0
    ? [{
        code: "unsupported_package_command_variant",
        file: ownerModule,
        detail: "package_argument_binding_pattern_is_not_static"
      }]
    : [];
  const reported = new Set<number>();
  const report = (node: ts.Expression) => {
    const start = node.getStart(sourceFile);
    if (reported.has(start)) return;
    reported.add(start);
    diagnostics.push({
      code: "unsupported_package_command_variant",
      file: ownerModule,
      detail: `unclassified_process_argv_root:${node.getText(sourceFile)}`
    });
  };
  const allowedUse = (node: ts.Expression, parent: ts.Node | undefined): boolean => {
    if (!parent) return false;
    if (ts.isVariableDeclaration(parent) && parent.initializer === node) return true;
    if (ts.isBindingElement(parent)) return true;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === node
    ) {
      return true;
    }
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.some((argument) => argument === node)
    ) {
      return true;
    }
    if (ts.isElementAccessExpression(parent)) {
      return parent.expression === node || parent.argumentExpression === node;
    }
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken)
    ) {
      return true;
    }
    if (ts.isSwitchStatement(parent) && parent.expression === node) return true;
    return false;
  };
  const visit = (node: ts.Node, parent?: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "slice"
    ) {
      const source = unwrapStaticExpression(node.expression.expression);
      const rawSequence = isProcessArgvExpression(source, flow) ||
        (ts.isIdentifier(source) && flow.rawSequences.has(source.text));
      if (rawSequence) {
        const start = node.arguments[0]
          ? unwrapStaticExpression(node.arguments[0])
          : null;
        if (!start || !ts.isNumericLiteral(start) || Number(start.text) !== 2) {
          report(node);
          return;
        }
        if (!allowedUse(node, parent)) report(node);
        return;
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const source = unwrapStaticExpression(node.expression);
      const directArgv = isProcessArgvExpression(source, flow);
      const sequenceAlias = ts.isIdentifier(source) && flow.sequences.has(source.text);
      if (directArgv || sequenceAlias) {
        const index = node.argumentExpression
          ? unwrapStaticExpression(node.argumentExpression)
          : null;
        if (
          directArgv &&
          index &&
          ts.isNumericLiteral(index) &&
          Number(index.text) < 2
        ) {
          return;
        }
        const expectedIndex = directArgv ||
          (ts.isIdentifier(source) && flow.rawSequences.has(source.text))
          ? 2
          : 0;
        if (!index || !ts.isNumericLiteral(index) || Number(index.text) !== expectedIndex) {
          report(node);
          return;
        }
        if (!allowedUse(node, parent)) report(node);
        return;
      }
    }
    if (ts.isExpression(node) && isProcessArgvExpression(node, flow)) {
      const consumedByElement = Boolean(
        parent && ts.isElementAccessExpression(parent) && parent.expression === node
      );
      const consumedBySlice =
        parent !== undefined &&
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === "slice";
      if (!consumedByElement && !consumedBySlice && !allowedUse(node, parent)) report(node);
      if (consumedByElement || consumedBySlice) return;
    }
    if (
      ts.isIdentifier(node) &&
      (flow.sequences.has(node.text) || flow.discriminators.has(node.text)) &&
      isIdentifierValueReference(node, parent) &&
      !isWithinStaticAssignmentTarget(node) &&
      !allowedUse(node, parent)
    ) {
      report(node);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, node));
  };
  ts.forEachChild(sourceFile, (child) => visit(child, sourceFile));
  return diagnostics;
}

function isWithinStaticAssignmentTarget(node: ts.Node): boolean {
  let current: ts.Node = node;
  while (current.parent && !ts.isStatement(current.parent)) {
    const parent = current.parent;
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      return parent.left === current || node.getStart() < parent.right.getStart();
    }
    current = parent;
  }
  return false;
}

function discoverTopLevelPackageArgumentTables(
  sourceFile: ts.SourceFile,
  ownerModule: string,
  moduleArgumentFlow: CommandArgumentFlow
): StructuralDiscovery {
  const observations: StructuralObservation[] = [];
  const diagnostics: OperationRegistryDiagnostic[] = [];
  const seenVariants = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      node !== sourceFile &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      const directKind = commandRootKindInExpression(
        node.argumentExpression,
        moduleArgumentFlow
      );
      const kind = directKind ?? (
        containsPotentialPackageArgumentRoot(
          sourceFile,
          node.argumentExpression,
          moduleArgumentFlow
        )
          ? "ambiguous"
          : null
      );
      if (kind) {
        const tableExpression = unwrapStaticExpression(node.expression);
        const tableName = ts.isIdentifier(tableExpression)
          ? tableExpression.text
          : "computed";
        if (kind !== "discriminator") {
          diagnostics.push({
            code: "unsupported_package_command_variant",
            file: ownerModule,
            detail: `package_argument_argv_index_is_not_static:${tableName}`
          });
        } else {
          const lookup = resolveStaticCommandLookupTable(sourceFile, tableExpression);
          if (!lookup.ok) {
            diagnostics.push({
              code: "unsupported_package_command_variant",
              file: ownerModule,
              detail: `package_argument_dispatch_table_is_not_static:${tableName}`
            });
          } else {
            for (const variant of lookup.variants) {
              const key = `${tableName}:${variant.value}`;
              if (seenVariants.has(key)) continue;
              seenVariants.add(key);
              observations.push({
                kind: "command_variant",
                ownerModule,
                symbol: variant.value,
                target: `${ownerModule}#${tableName}:${variant.value}`,
                anchorFile: ownerModule,
                anchorStart: variant.anchor.getStart(sourceFile),
                anchorEnd: variant.anchor.getEnd()
              });
            }
          }
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { observations, diagnostics };
}

function containsPotentialPackageArgumentRoot(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
  flow: CommandArgumentFlow,
  seen = new Set<string>()
): boolean {
  const current = unwrapStaticExpression(expression);
  if (commandRootKindInExpression(current, flow)) return true;
  if (ts.isIdentifier(current)) {
    if (seen.has(current.text)) return false;
    seen.add(current.text);
    const declaration = findVariableDeclaration(sourceFile, current.text);
    return Boolean(
      declaration?.initializer &&
      containsPotentialPackageArgumentRoot(
        sourceFile,
        declaration.initializer,
        flow,
        seen
      )
    );
  }
  let found = false;
  const visit = (node: ts.Node) => {
    if (node !== current && ts.isExpression(node)) {
      if (commandRootKindInExpression(node, flow)) {
        found = true;
        return;
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(current, visit);
  return found;
}

type CommandArgumentFlow = {
  readonly checker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly sequences: ReadonlySet<string>;
  readonly rawSequences: ReadonlySet<string>;
  readonly discriminators: ReadonlySet<string>;
  readonly processObjects: ReadonlySet<string>;
  readonly unsupportedBindingPatterns: Set<number>;
};

function traceCommandArgumentFlow(
  checker: ts.TypeChecker,
  statement: CommandFunction,
  parameterRoots: CommandFunctionParameterRoots
): CommandArgumentFlow {
  const sequences = new Set<string>();
  const rawSequences = new Set<string>();
  const discriminators = new Set<string>();
  const processObjects = new Set<string>(["process"]);
  const unsupportedBindingPatterns = new Set<number>();
  const flow = {
    checker,
    sourceFile: statement.body.getSourceFile(),
    sequences,
    rawSequences,
    discriminators,
    processObjects,
    unsupportedBindingPatterns
  };
  for (const [index, kinds] of parameterRoots) {
    const parameter = statement.parameters[index];
    if (!parameter) continue;
    if (ts.isIdentifier(parameter.name)) {
      if (kinds.has("process")) processObjects.add(parameter.name.text);
      if (kinds.has("raw_sequence")) {
        sequences.add(parameter.name.text);
        rawSequences.add(parameter.name.text);
      }
      if (kinds.has("sequence")) sequences.add(parameter.name.text);
      if (kinds.has("discriminator")) discriminators.add(parameter.name.text);
      continue;
    }
    if (kinds.has("process")) {
      if (ts.isObjectBindingPattern(parameter.name)) {
        applyProcessObjectBindingPattern(parameter.name, flow);
      } else {
        unsupportedBindingPatterns.add(parameter.name.getStart());
      }
    }
    if (kinds.has("raw_sequence")) {
      applyCommandSequenceBindingPattern(parameter.name, "raw", flow);
    }
    if (kinds.has("sequence")) {
      applyCommandSequenceBindingPattern(parameter.name, "command", flow);
    }
    if (kinds.has("discriminator")) {
      unsupportedBindingPatterns.add(parameter.name.getStart());
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && isIdentifierValueReference(node)) {
        const symbol = staticIdentifierValueSymbol(checker, node);
        const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        const parameterRoot = Boolean(
          declaration && (
            ts.isParameter(declaration) ||
            (ts.isBindingElement(declaration) &&
              staticParameterBindingElementSource(declaration).kind === "resolved")
          )
        );
        if (parameterRoot) {
          const kind = commandRootKindInExpression(node, flow);
          const add = (set: Set<string>) => {
            if (set.has(node.text)) return;
            set.add(node.text);
            changed = true;
          };
          if (kind === "process") add(processObjects);
          if (kind === "raw_sequence") {
            add(sequences);
            add(rawSequences);
          }
          if (kind === "sequence") add(sequences);
          if (kind === "discriminator") add(discriminators);
        }
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        if (applyCommandFlowAssignment(node.name, node.initializer, flow)) changed = true;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        if (applyCommandFlowAssignment(node.left, node.right, flow)) changed = true;
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(statement.body, visit);
  }
  return flow;
}

function commandArgumentExpressionKind(
  expression: ts.Expression,
  flow: CommandArgumentFlow
): CommandArgumentRootKind | null {
  const current = unwrapStaticExpression(expression);
  if (ts.isIdentifier(current)) {
    if (flow.sequences.has(current.text)) return "sequence";
    if (flow.discriminators.has(current.text)) return "discriminator";
  }
  if (nodeContainsIdentifier(current, flow.discriminators)) return "discriminator";
  if (nodeContainsIdentifier(current, flow.sequences)) return "sequence";
  return null;
}

function resolveStaticCommandLiteral(
  root: ts.Node,
  expression: ts.Expression,
  seen = new Set<string>()
): { readonly value: string } | null {
  const current = unwrapStaticExpression(expression);
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return { value: current.text };
  }
  if (!ts.isIdentifier(current) || seen.has(current.text)) return null;
  seen.add(current.text);
  const declaration = findVariableDeclaration(root, current.text);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return null;
  }
  return resolveStaticCommandLiteral(root, declaration.initializer, seen);
}

function nodeContainsIdentifier(root: ts.Node, identifiers: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && identifiers.has(node.text)) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

type StaticCommandLookup =
  | {
      readonly ok: true;
      readonly variants: readonly { readonly value: string; readonly anchor: ts.Node }[];
    }
  | { readonly ok: false };

function resolveStaticCommandLookupTable(
  root: ts.Node,
  expression: ts.Expression,
  seen = new Set<string>()
): StaticCommandLookup {
  const current = unwrapStaticExpression(expression);
  if (!ts.isIdentifier(current) || seen.has(current.text)) return { ok: false };
  seen.add(current.text);
  const declaration = findVariableDeclaration(root, current.text);
  if (
    !declaration?.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    return { ok: false };
  }
  const initializer = unwrapStaticExpression(declaration.initializer);
  if (ts.isIdentifier(initializer)) {
    return resolveStaticCommandLookupTable(root, initializer, seen);
  }
  if (!ts.isObjectLiteralExpression(initializer) || initializer.properties.length === 0) {
    return { ok: false };
  }
  const variants: Array<{ readonly value: string; readonly anchor: ts.Node }> = [];
  for (const property of initializer.properties) {
    if (
      (!ts.isPropertyAssignment(property) &&
        !ts.isMethodDeclaration(property) &&
        !ts.isShorthandPropertyAssignment(property)) ||
      ts.isComputedPropertyName(property.name)
    ) {
      return { ok: false };
    }
    const key = propertyName(property.name);
    if (!key?.trim()) return { ok: false };
    if (ts.isMethodDeclaration(property)) {
      if (!property.body) return { ok: false };
      variants.push({ value: key, anchor: property });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      if (!isStaticCommandCallable(root, property.name)) return { ok: false };
      variants.push({ value: key, anchor: property });
      continue;
    }
    const value = unwrapStaticExpression(property.initializer);
    const callable =
      ts.isArrowFunction(value) ||
      ts.isFunctionExpression(value) ||
      (ts.isIdentifier(value) && isStaticCommandCallable(root, value));
    const kind = ts.isObjectLiteralExpression(value)
      ? value.properties.find(
          (entry): entry is ts.PropertyAssignment =>
            ts.isPropertyAssignment(entry) && propertyName(entry.name) === "kind"
        )
      : undefined;
    const literalKind = kind ? unwrapStaticExpression(kind.initializer) : null;
    if (
      !callable &&
      (!literalKind || !ts.isStringLiteral(literalKind) || literalKind.text !== key)
    ) {
      return { ok: false };
    }
    variants.push({ value: key, anchor: property });
  }
  return { ok: true, variants };
}

function isStaticCommandCallable(root: ts.Node, identifier: ts.Identifier): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === identifier.text &&
      node.body
    ) {
      found = true;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === identifier.text &&
      node.initializer
    ) {
      const initializer = unwrapStaticExpression(node.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        found = true;
        return;
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function unwrapStaticExpression(expression: ts.Expression): ts.Expression {
  let current = unwrapParentheses(expression);
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = unwrapParentheses(current.expression);
  }
  return current;
}

function containsReturnedKindProperty(root: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      found = node.expression.properties.some(
        (property) =>
          ts.isPropertyAssignment(property) && propertyName(property.name) === "kind"
      );
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

type DynamicWorkerImport = {
  readonly local: string;
  readonly target: string;
  readonly binding: ts.BindingElement;
  readonly importCall: ts.CallExpression;
};

function discoverPromiseAllDynamicImports(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  repositoryRoot: string
): DynamicWorkerImport[] {
  const output: DynamicWorkerImport[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer
    ) {
      const initializer = unwrapAwait(node.initializer);
      if (
        ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        ts.isIdentifier(initializer.expression.expression) &&
        initializer.expression.expression.text === "Promise" &&
        initializer.expression.name.text === "all" &&
        initializer.arguments[0] &&
        ts.isArrayLiteralExpression(initializer.arguments[0])
      ) {
        const imports = initializer.arguments[0].elements;
        node.name.elements.forEach((element, index) => {
          const imported = imports[index];
          if (
            !ts.isBindingElement(element) ||
            !ts.isObjectBindingPattern(element.name) ||
            element.name.elements.length !== 1 ||
            !imported ||
            !ts.isCallExpression(imported) ||
            imported.expression.kind !== ts.SyntaxKind.ImportKeyword ||
            !imported.arguments[0] ||
            !ts.isStringLiteral(imported.arguments[0])
          ) {
            return;
          }
          const binding = element.name.elements[0];
          if (!ts.isIdentifier(binding.name)) return;
          const exported = binding.propertyName && ts.isIdentifier(binding.propertyName)
            ? binding.propertyName.text
            : binding.name.text;
          const modulePath = resolveModuleSpecifierPath(
            program,
            sourceFile,
            repositoryRoot,
            imported.arguments[0].text
          );
          if (!modulePath) return;
          output.push({
            local: binding.name.text,
            target: `${modulePath}#${exported}`,
            binding,
            importCall: imported
          });
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return output;
}

function unwrapAwait(expression: ts.Expression): ts.Expression {
  const unwrapped = unwrapParentheses(expression);
  return ts.isAwaitExpression(unwrapped) ? unwrapParentheses(unwrapped.expression) : unwrapped;
}

function resolveModuleSpecifierPath(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  repositoryRoot: string,
  specifier: string
): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(repositoryRoot, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(sourceFile.fileName), specifier)
      : null;
  if (!base) return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
    resolve(base, "index.mts"),
    resolve(base, "index.cts")
  ];
  const source = program.getSourceFiles().find((entry) =>
    candidates.some((candidate) => resolve(candidate) === resolve(entry.fileName))
  );
  return source ? relativeModule(repositoryRoot, source.fileName) : null;
}

function findVariableDeclaration(root: ts.Node, name: string): ts.VariableDeclaration | null {
  let found: ts.VariableDeclaration | null = null;
  const visit = (node: ts.Node) => {
    if (
      !found &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      found = node;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function findCallExpression(root: ts.Node, calleeName: string): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;
  const visit = (node: ts.Node) => {
    if (
      !found &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === calleeName
    ) {
      found = node;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function containsDirectIdentifierCall(root: ts.Node, calleeName: string): boolean {
  return Boolean(findCallExpression(root, calleeName));
}

function isGlobalIdentifier(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  ownerSource: ts.SourceFile
): boolean {
  const symbol = ts.isShorthandPropertyAssignment(identifier.parent) &&
    identifier.parent.name === identifier
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent) ??
      checker.getSymbolAtLocation(identifier)
    : checker.getSymbolAtLocation(identifier);
  return !symbol?.declarations?.some(
    (declaration) => declaration.getSourceFile() === ownerSource
  );
}

function resolveGlobalFetchBinding(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ownerSource: ts.SourceFile,
  seen = new Set<ts.Symbol>(),
  seenMembers = new Set<string>()
): { readonly symbol: string } | null {
  const current = unwrapParentheses(expression);
  const staticRoot = resolveStaticRootFlow(
    checker,
    current,
    globalObjectRootFlowOptions(checker, ownerSource)
  );
  if (isResolvedGlobalFetchRoot(staticRoot)) {
    const member = staticMemberPath(current);
    return {
      symbol: ts.isIdentifier(current)
        ? current.text
        : member
          ? [member.root.text, ...member.parts].join(".")
          : current.getText(ownerSource)
    };
  }
  if (ts.isIdentifier(current)) {
    if (current.text === "fetch" && isGlobalIdentifier(checker, current, ownerSource)) {
      return { symbol: "fetch" };
    }
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || seen.has(symbol)) return null;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = resolveStaticVariableValue(checker, declaration);
      if (
        value.kind === "resolved" &&
        resolveGlobalFetchBinding(checker, value.expression, ownerSource, seen)
      ) {
        return { symbol: current.text };
      }
    }
    if (declaration && ts.isBindingElement(declaration)) {
      const pattern = declaration.parent;
      const variable = pattern.parent;
      const boundName = declaration.propertyName
        ? propertyName(declaration.propertyName)
        : ts.isIdentifier(declaration.name)
          ? declaration.name.text
          : null;
      if (
        ts.isObjectBindingPattern(pattern) &&
        ts.isVariableDeclaration(variable) &&
        variable.initializer &&
        boundName === "fetch" &&
        isGlobalObjectExpression(checker, variable.initializer, ownerSource)
      ) {
        return { symbol: current.text };
      }
    }
    return null;
  }
  if (
    ts.isPropertyAccessExpression(current) &&
    current.name.text === "fetch" &&
    ts.isIdentifier(current.expression) &&
    (current.expression.text === "globalThis" || current.expression.text === "window") &&
    isGlobalIdentifier(checker, current.expression, ownerSource)
  ) {
    return { symbol: `${current.expression.text}.fetch` };
  }
  if (
    ts.isElementAccessExpression(current) &&
    current.argumentExpression &&
    (ts.isStringLiteral(current.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(current.argumentExpression)) &&
    current.argumentExpression.text === "fetch" &&
    isGlobalObjectExpression(checker, current.expression, ownerSource)
  ) {
    const root = unwrapParentheses(current.expression);
    return { symbol: `${ts.isIdentifier(root) ? root.text : "globalThis"}.fetch` };
  }
  if (ts.isPropertyAccessExpression(current)) {
    const member = staticMemberPath(current);
    const rootSymbol = member ? checker.getSymbolAtLocation(member.root) : undefined;
    const memberKey = rootSymbol && member
      ? `${rootSymbol.valueDeclaration?.getStart() ?? rootSymbol.getName()}:${member.parts.join(".")}`
      : null;
    if (memberKey && !seenMembers.has(memberKey)) {
      seenMembers.add(memberKey);
      const value = resolveStaticMemberValue(checker, current);
      if (
        value.kind === "resolved" &&
        resolveGlobalFetchBinding(
          checker,
          value.expression,
          ownerSource,
          seen,
          seenMembers
        )
      ) {
        return {
          symbol: [member!.root.text, ...member!.parts].join(".")
        };
      }
    }
  }
  return null;
}

function isGlobalObjectExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ownerSource: ts.SourceFile
): boolean {
  const current = unwrapParentheses(expression);
  const root = resolveStaticRootFlow(
    checker,
    current,
    globalObjectRootFlowOptions(checker, ownerSource)
  );
  return root.kind === "resolved" &&
    root.root === "browser_global" &&
    root.path.length === 0;
}

function looksLikeFetchBinding(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ownerSource: ts.SourceFile
): boolean {
  const staticRoot = resolveStaticRootFlow(
    checker,
    expression,
    globalObjectRootFlowOptions(checker, ownerSource)
  );
  if (isResolvedGlobalFetchRoot(staticRoot) || isAmbiguousGlobalFetchRoot(staticRoot)) {
    return true;
  }
  if (staticMemberValueMayAliasGlobalFetch(checker, expression, ownerSource)) {
    return true;
  }
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isIdentifier(node) &&
        node.text === "fetch" &&
        isGlobalIdentifier(checker, node, ownerSource)) ||
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === "fetch" &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "globalThis" || node.expression.text === "window")) ||
      (ts.isElementAccessExpression(node) &&
        isGlobalObjectExpression(checker, node.expression, ownerSource))
    ) {
      found = true;
      return;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isBindingElement(declaration)) {
        const pattern = declaration.parent;
        const variable = pattern.parent;
        if (
          ts.isObjectBindingPattern(pattern) &&
          ts.isVariableDeclaration(variable) &&
          variable.initializer &&
          isGlobalObjectExpression(checker, variable.initializer, ownerSource)
        ) {
          found = true;
          return;
        }
      }
    }
    if (
      ts.isIdentifier(node) &&
      (resolveGlobalFetchBinding(checker, node, ownerSource) ||
        hasPotentialGlobalFetchAssignment(checker, node, ownerSource))
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function globalObjectRootFlowOptions(
  checker: ts.TypeChecker,
  ownerSource: ts.SourceFile
): StaticRootFlowOptions {
  return {
    identifyRoot: (identifier) =>
      (identifier.text === "globalThis" || identifier.text === "window") &&
      isGlobalIdentifier(checker, identifier, ownerSource)
        ? "browser_global"
        : identifier.text === "fetch" &&
            isGlobalIdentifier(checker, identifier, ownerSource)
          ? "global_fetch"
        : null
  };
}

function isResolvedGlobalFetchRoot(
  resolution: StaticRootFlowResolution
): boolean {
  return resolution.kind === "resolved" && (
    (resolution.root === "global_fetch" && resolution.path.length === 0) ||
    (resolution.root === "browser_global" &&
      resolution.path.length === 1 &&
      resolution.path[0].kind === "property" &&
      resolution.path[0].key === "fetch")
  );
}

function isAmbiguousGlobalFetchRoot(
  resolution: StaticRootFlowResolution
): boolean {
  return resolution.kind === "ambiguous" &&
    ((resolution.root === "global_fetch" && !resolution.path?.length) ||
      (resolution.root === "browser_global" && Boolean(
        resolution.path?.some(
          (segment) => segment.kind === "property" && segment.key === "fetch"
        )
      )));
}

function staticMemberValueMayAliasGlobalFetch(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ownerSource: ts.SourceFile
): boolean {
  const value = resolveStaticMemberValue(checker, expression);
  if (value.kind === "none") return false;
  const expressions = value.kind === "resolved" ? [value.expression] : value.expressions;
  return expressions.some((candidate) =>
    expressionMayAliasGlobalFetch(checker, candidate, ownerSource)
  );
}

function hasPotentialGlobalFetchAssignment(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  ownerSource: ts.SourceFile
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
  const value = resolveStaticVariableValue(checker, declaration);
  if (value.kind === "none") return false;
  const expressions = value.kind === "resolved" ? [value.expression] : value.expressions;
  return expressions.some((expression) =>
    expressionMayAliasGlobalFetch(checker, expression, ownerSource)
  );
}

function expressionMayAliasGlobalFetch(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ownerSource: ts.SourceFile
): boolean {
  const current = unwrapStaticExpression(expression);
  if (ts.isAwaitExpression(current) || ts.isCallExpression(current)) return false;
  const root = resolveStaticRootFlow(
    checker,
    current,
    globalObjectRootFlowOptions(checker, ownerSource)
  );
  if (isResolvedGlobalFetchRoot(root) || isAmbiguousGlobalFetchRoot(root)) return true;
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isExpression(node) &&
      resolveGlobalFetchBinding(checker, node, ownerSource)
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(current);
  return found;
}

type StaticMemberPath = {
  readonly root: ts.Identifier;
  readonly parts: readonly string[];
};

function staticMemberPath(expression: ts.Expression): StaticMemberPath | null {
  const parts: string[] = [];
  let current = unwrapParentheses(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = unwrapParentheses(current.expression);
      continue;
    }
    const argument = current.argumentExpression;
    if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) {
      return null;
    }
    parts.unshift(argument.text);
    current = unwrapParentheses(current.expression);
  }
  return ts.isIdentifier(current) ? { root: current, parts } : null;
}

function isBetterAuthClientRoot(
  checker: ts.TypeChecker,
  root: ts.Identifier,
  repositoryRoot: string,
  seen = new Set<ts.Symbol>()
): boolean {
  const local = staticIdentifierValueSymbol(checker, root);
  if (!local || seen.has(local)) return false;
  seen.add(local);
  const target = (local.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(local)
    : local;
  const dynamicTarget = resolveDynamicImportBindingSymbol(checker, target);
  const resolvedTarget = dynamicTarget ?? target;
  const declaration = resolvedTarget.valueDeclaration ?? resolvedTarget.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
  if (!resolve(declaration.getSourceFile().fileName).startsWith(resolve(repositoryRoot))) {
    return false;
  }
  const value = resolveStaticVariableValue(checker, declaration);
  if (value.kind !== "resolved") return false;
  const initializer = unwrapParentheses(value.expression);
  if (ts.isIdentifier(initializer)) {
    return isBetterAuthClientRoot(checker, initializer, repositoryRoot, seen);
  }
  if (!ts.isCallExpression(initializer)) return false;
  return isBetterAuthFactoryExpression(checker, initializer.expression);
}

function isBetterAuthFactoryExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression
): boolean {
  const current = unwrapStaticExpression(expression);
  if (ts.isIdentifier(current)) {
    return isBetterAuthFactoryIdentifier(checker, current);
  }
  if (
    !ts.isPropertyAccessExpression(current) &&
    !ts.isElementAccessExpression(current)
  ) {
    return false;
  }
  const memberName = ts.isPropertyAccessExpression(current)
    ? current.name.text
    : current.argumentExpression &&
        (ts.isStringLiteral(current.argumentExpression) ||
          ts.isNoSubstitutionTemplateLiteral(current.argumentExpression))
      ? current.argumentExpression.text
      : null;
  if (memberName !== "createAuthClient") return false;
  let moduleExpression = unwrapStaticExpression(current.expression);
  if (ts.isAwaitExpression(moduleExpression)) {
    moduleExpression = unwrapStaticExpression(moduleExpression.expression);
  }
  if (
    !ts.isCallExpression(moduleExpression) ||
    moduleExpression.expression.kind !== ts.SyntaxKind.ImportKeyword
  ) {
    return false;
  }
  const argument = moduleExpression.arguments[0];
  return Boolean(
    argument &&
    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
    argument.text === "better-auth/react"
  );
}

function isBetterAuthFactoryIdentifier(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  seen = new Set<ts.Symbol>()
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const importSpecifier = symbol.declarations?.find(ts.isImportSpecifier);
  const importDeclaration = importSpecifier ? containingImportDeclaration(importSpecifier) : null;
  if (
    importSpecifier &&
    importDeclaration &&
    ts.isStringLiteral(importDeclaration.moduleSpecifier) &&
    importDeclaration.moduleSpecifier.text === "better-auth/react" &&
    (importSpecifier.propertyName?.text ?? importSpecifier.name.text) === "createAuthClient"
  ) {
    return true;
  }
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration && ts.isBindingElement(declaration)) {
    const binding = dynamicImportBinding(declaration);
    if (
      binding?.specifier === "better-auth/react" &&
      binding.exportName === "createAuthClient"
    ) {
      return true;
    }
  }
  if (declaration && ts.isVariableDeclaration(declaration)) {
    const value = resolveStaticVariableValue(checker, declaration);
    if (value.kind === "resolved") {
      const current = unwrapStaticExpression(value.expression);
      return ts.isIdentifier(current) &&
        isBetterAuthFactoryIdentifier(checker, current, seen);
    }
  }
  return false;
}

function dynamicImportBinding(
  declaration: ts.BindingElement
): { readonly specifier: string; readonly exportName: string } | null {
  if (!ts.isObjectBindingPattern(declaration.parent)) return null;
  const variable = declaration.parent.parent;
  if (!ts.isVariableDeclaration(variable) || !variable.initializer) return null;
  let initializer = unwrapStaticExpression(variable.initializer);
  if (ts.isAwaitExpression(initializer)) {
    initializer = unwrapStaticExpression(initializer.expression);
  }
  if (
    !ts.isCallExpression(initializer) ||
    initializer.expression.kind !== ts.SyntaxKind.ImportKeyword
  ) {
    return null;
  }
  const argument = initializer.arguments[0];
  if (
    !argument ||
    (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))
  ) {
    return null;
  }
  const exportName = declaration.propertyName
    ? propertyName(declaration.propertyName)
    : ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : null;
  return exportName ? { specifier: argument.text, exportName } : null;
}

type SensitiveDynamicImport = {
  readonly call: ts.CallExpression;
  readonly unsupportedShape: boolean;
};

function collectSensitiveDynamicImports(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  repositoryRoot: string
): readonly SensitiveDynamicImport[] {
  const imports: SensitiveDynamicImport[] = [];
  const visit = (node: ts.Node) => {
    if (
      !ts.isCallExpression(node) ||
      node.expression.kind !== ts.SyntaxKind.ImportKeyword
    ) {
      ts.forEachChild(node, visit);
      return;
    }
    const argument = node.arguments[0];
    if (
      !argument ||
      (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))
    ) {
      return;
    }
    const sensitive = argument.text === "better-auth/react" ||
      dynamicImportModuleHasSensitiveExports(checker, argument, repositoryRoot);
    if (!sensitive) return;
    let current: ts.Node = node;
    if (ts.isAwaitExpression(current.parent)) current = current.parent;
    while (
      current.parent &&
      (ts.isParenthesizedExpression(current.parent) ||
        ts.isAsExpression(current.parent) ||
        ts.isSatisfiesExpression(current.parent))
    ) {
      current = current.parent;
    }
    const variable = current.parent && ts.isVariableDeclaration(current.parent)
      ? current.parent
      : null;
    const unsupportedShape = Boolean(
      variable &&
      (ts.isArrayBindingPattern(variable.name) ||
        (ts.isObjectBindingPattern(variable.name) &&
          (variable.name.elements.length === 0 ||
            variable.name.elements.some((element) =>
              Boolean(element.dotDotDotToken) ||
              !ts.isIdentifier(element.name) ||
              Boolean(element.propertyName && ts.isComputedPropertyName(element.propertyName))
            ))))
    );
    imports.push({ call: node, unsupportedShape });
  };
  ts.forEachChild(sourceFile, visit);
  return imports;
}

function expressionDependsOnDynamicImport(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  target: ts.CallExpression,
  seenSymbols = new Set<ts.Symbol>()
): boolean {
  const current = unwrapStaticExpression(expression);
  if (current === target) return true;
  if (ts.isAwaitExpression(current)) {
    return expressionDependsOnDynamicImport(
      checker,
      current.expression,
      target,
      seenSymbols
    );
  }
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || seenSymbols.has(symbol)) return false;
    seenSymbols.add(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = resolveStaticVariableValue(checker, declaration);
      const expressions = value.kind === "resolved"
        ? [value.expression]
        : value.kind === "unsupported"
          ? value.expressions
          : [];
      return expressions.some((candidate) => expressionDependsOnDynamicImport(
        checker,
        candidate,
        target,
        new Set(seenSymbols)
      ));
    }
    if (declaration && ts.isBindingElement(declaration)) {
      const variable = declaration.parent.parent;
      return Boolean(
        ts.isVariableDeclaration(variable) &&
        variable.initializer &&
        expressionDependsOnDynamicImport(
          checker,
          variable.initializer,
          target,
          new Set(seenSymbols)
        )
      );
    }
    return false;
  }
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    return expressionDependsOnDynamicImport(
      checker,
      current.expression,
      target,
      new Set(seenSymbols)
    );
  }
  if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
    const callee = current.expression;
    if (
      expressionDependsOnDynamicImport(
        checker,
        callee,
        target,
        new Set(seenSymbols)
      )
    ) {
      return true;
    }
    return current.arguments?.some((argument) => expressionDependsOnDynamicImport(
      checker,
      argument,
      target,
      new Set(seenSymbols)
    )) ?? false;
  }
  let found = false;
  const visit = (node: ts.Node) => {
    if (node === target) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(current, visit);
  return found;
}

function dynamicImportModuleHasSensitiveExports(
  checker: ts.TypeChecker,
  argument: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
  repositoryRoot: string
): boolean {
  const moduleSymbol = checker.getSymbolAtLocation(argument);
  if (!moduleSymbol) return false;
  return checker.getExportsOfModule(moduleSymbol).some((exported) => {
    const target = (exported.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(exported)
      : exported;
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    if (!declaration) return false;
    const declarationSource = declaration.getSourceFile();
    if (!resolve(declarationSource.fileName).startsWith(resolve(repositoryRoot))) return false;
    if (
      hasUseServerDirective(declarationSource.statements) ||
      (isFunctionLikeWithBlock(declaration) &&
        hasUseServerDirective(declaration.body.statements))
    ) {
      return true;
    }
    if (!ts.isVariableDeclaration(declaration)) return false;
    const value = resolveStaticVariableValue(checker, declaration);
    if (value.kind !== "resolved") return false;
    const initializer = unwrapStaticExpression(value.expression);
    return Boolean(
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      isBetterAuthFactoryIdentifier(checker, initializer.expression)
    );
  });
}

function resolveDynamicImportBindingSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol
): ts.Symbol | null {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration || !ts.isBindingElement(declaration)) return null;
  const binding = dynamicImportBinding(declaration);
  if (!binding) return null;
  const variable = declaration.parent.parent;
  let initializer = unwrapStaticExpression(variable.initializer!);
  if (ts.isAwaitExpression(initializer)) initializer = unwrapStaticExpression(initializer.expression);
  const argument = (initializer as ts.CallExpression).arguments[0];
  const moduleSymbol = argument ? checker.getSymbolAtLocation(argument) : undefined;
  if (!moduleSymbol) return null;
  const exported = checker.getExportsOfModule(moduleSymbol).find(
    (entry) => entry.getName() === binding.exportName
  );
  if (!exported) return null;
  return (exported.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(exported)
    : exported;
}

function containingImportDeclaration(node: ts.Node): ts.ImportDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current && !ts.isImportDeclaration(current)) current = current.parent;
  return current && ts.isImportDeclaration(current) ? current : null;
}

function resolveBetterAuthCallBinding(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string,
  seen = new Set<ts.Symbol>(),
  seenMembers = new Set<string>()
): { readonly symbol: string; readonly path: readonly string[] } | null {
  const staticRoot = resolveStaticRootFlow(checker, expression, {
    identifyRoot: (identifier) =>
      isBetterAuthClientRoot(checker, identifier, repositoryRoot)
        ? "better_auth_client"
        : null
  });
  if (
    staticRoot.kind === "resolved" &&
    staticRoot.root === "better_auth_client" &&
    staticRoot.path.length > 0 &&
    staticRoot.path.every((segment) => segment.kind === "property")
  ) {
    const member = staticMemberPath(expression);
    return {
      symbol: member
        ? [member.root.text, ...member.parts].join(".")
        : expression.getText(expression.getSourceFile()),
      path: staticRoot.path.map((segment) =>
        (segment as Extract<StaticRootFlowSegment, { kind: "property" }>).key
      )
    };
  }
  const member = staticMemberPath(expression);
  if (
    member &&
    member.parts.length > 0 &&
    isBetterAuthClientRoot(checker, member.root, repositoryRoot)
  ) {
    return {
      symbol: [member.root.text, ...member.parts].join("."),
      path: member.parts
    };
  }
  if (ts.isPropertyAccessExpression(expression) && member) {
    const rootSymbol = checker.getSymbolAtLocation(member.root);
    const memberKey = rootSymbol
      ? `${rootSymbol.valueDeclaration?.getStart() ?? rootSymbol.getName()}:${member.parts.join(".")}`
      : null;
    if (memberKey && !seenMembers.has(memberKey)) {
      seenMembers.add(memberKey);
      const value = resolveStaticMemberValue(checker, expression);
      if (value.kind === "resolved") {
        const delegated = resolveBetterAuthCallBinding(
          checker,
          value.expression,
          repositoryRoot,
          seen,
          seenMembers
        );
        if (delegated) {
          return {
            symbol: [member.root.text, ...member.parts].join("."),
            path: delegated.path
          };
        }
      }
    }
  }
  if (!ts.isIdentifier(expression)) return null;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (declaration && ts.isVariableDeclaration(declaration)) {
    const value = resolveStaticVariableValue(checker, declaration);
    const target = value.kind === "resolved" ? staticMemberPath(value.expression) : null;
    if (
      target &&
      target.parts.length > 0 &&
      isBetterAuthClientRoot(checker, target.root, repositoryRoot)
    ) {
      return { symbol: expression.text, path: target.parts };
    }
    if (value.kind === "resolved") {
      const delegated = resolveBetterAuthCallBinding(
        checker,
        unwrapStaticExpression(value.expression),
        repositoryRoot,
        seen,
        seenMembers
      );
      if (delegated) {
        return { symbol: expression.text, path: delegated.path };
      }
    }
  }
  if (declaration && ts.isBindingElement(declaration)) {
    const pattern = declaration.parent;
    const variable = pattern.parent;
    if (
      ts.isObjectBindingPattern(pattern) &&
      ts.isVariableDeclaration(variable) &&
      variable.initializer
    ) {
      const root = staticMemberPath(variable.initializer);
      const name = declaration.propertyName
        ? propertyName(declaration.propertyName)
        : ts.isIdentifier(declaration.name)
          ? declaration.name.text
          : null;
      if (
        root &&
        name &&
        isBetterAuthClientRoot(checker, root.root, repositoryRoot)
      ) {
        return { symbol: expression.text, path: [...root.parts, name] };
      }
    }
  }
  return null;
}

function containsBetterAuthBinding(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string
): boolean {
  const staticRoot = resolveStaticRootFlow(checker, expression, {
    identifyRoot: (identifier) =>
      isBetterAuthClientRoot(checker, identifier, repositoryRoot)
        ? "better_auth_client"
        : null
  });
  if (staticRoot.kind !== "none" && staticRoot.root === "better_auth_client") {
    return true;
  }
  if (staticMemberValueMayAliasBetterAuth(checker, expression, repositoryRoot)) {
    return true;
  }
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      node !== expression &&
      ts.isCallExpression(node) &&
      resolveBetterAuthCallBinding(checker, node.expression, repositoryRoot)
    ) {
      return;
    }
    if (
      ts.isIdentifier(node) &&
      (isBetterAuthClientRoot(checker, node, repositoryRoot) ||
        Boolean(resolveBetterAuthCallBinding(checker, node, repositoryRoot)) ||
        hasPotentialBetterAuthAssignment(checker, node, repositoryRoot))
    ) {
      found = true;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isBindingElement(declaration)) {
        const pattern = declaration.parent;
        const variable = pattern.parent;
        if (
          ts.isObjectBindingPattern(pattern) &&
          ts.isVariableDeclaration(variable) &&
          variable.initializer
        ) {
          const member = staticMemberPath(variable.initializer);
          if (member && isBetterAuthClientRoot(checker, member.root, repositoryRoot)) {
            found = true;
          }
        }
      }
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function staticMemberValueMayAliasBetterAuth(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string
): boolean {
  const value = resolveStaticMemberValue(checker, expression);
  if (value.kind === "none") return false;
  const expressions = value.kind === "resolved" ? [value.expression] : value.expressions;
  return expressions.some((candidate) =>
    expressionMayAliasBetterAuth(checker, candidate, repositoryRoot)
  );
}

type StaticVariableValue =
  | { readonly kind: "resolved"; readonly expression: ts.Expression }
  | { readonly kind: "none" }
  | { readonly kind: "unsupported"; readonly expressions: readonly ts.Expression[] };

type StaticRootFlowSegment =
  | { readonly kind: "property"; readonly key: string }
  | { readonly kind: "slice"; readonly start: number }
  | { readonly kind: "object_rest"; readonly excluded: readonly string[] };

type StaticRootFlowResolution =
  | {
      readonly kind: "resolved";
      readonly root: string;
      readonly path: readonly StaticRootFlowSegment[];
    }
  | { readonly kind: "none" }
  | {
      readonly kind: "ambiguous";
      readonly root?: string;
      readonly path?: readonly StaticRootFlowSegment[];
    };

type StaticRootFlowOptions = {
  readonly identifyRoot: (identifier: ts.Identifier) => string | null;
};

function resolveStaticRootFlow(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  options: StaticRootFlowOptions,
  path: readonly StaticRootFlowSegment[] = [],
  seenSymbols = new Set<ts.Symbol>()
): StaticRootFlowResolution {
  const current = unwrapStaticExpression(expression);
  if (ts.isIdentifier(current)) {
    const root = options.identifyRoot(current);
    if (root) return { kind: "resolved", root, path };
    const symbol = staticIdentifierValueSymbol(checker, current);
    if (!symbol || seenSymbols.has(symbol)) return { kind: "none" };
    const nextSeen = new Set(seenSymbols);
    nextSeen.add(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration && ts.isParameter(declaration)) {
      return resolveStaticParameterRootFlow(
        checker,
        declaration,
        options,
        path,
        nextSeen
      );
    }
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = resolveStaticVariableValue(checker, declaration);
      const candidates = value.kind === "resolved"
        ? [value.expression]
        : value.kind === "unsupported"
          ? value.expressions
          : [];
      const resolved = candidates.map((candidate) =>
        resolveStaticRootFlow(checker, candidate, options, path, new Set(nextSeen))
      );
      if (
        value.kind === "unsupported" &&
        resolved.some((entry) => entry.kind !== "none")
      ) {
        return ambiguousStaticRootFlow(resolved);
      }
      return mergeStaticRootFlowResolutions(resolved);
    }
    if (declaration && ts.isBindingElement(declaration)) {
      const binding = staticBindingElementSource(declaration);
      if (binding.kind === "ambiguous") return { kind: "ambiguous" };
      if (binding.kind === "resolved") {
        const selected = resolveStaticRootFlow(
          checker,
          binding.source,
          options,
          [...binding.path, ...path],
          nextSeen
        );
        if (selected.kind !== "none" || !declaration.initializer) return selected;
        return resolveStaticRootFlow(
          checker,
          declaration.initializer,
          options,
          path,
          nextSeen
        );
      }
      const parameterBinding = staticParameterBindingElementSource(declaration);
      if (parameterBinding.kind === "ambiguous") {
        return { kind: "ambiguous" };
      }
      if (parameterBinding.kind === "resolved") {
        const selected = resolveStaticParameterRootFlow(
          checker,
          parameterBinding.parameter,
          options,
          [...parameterBinding.path, ...path],
          nextSeen
        );
        if (selected.kind !== "none" || !declaration.initializer) return selected;
        return resolveStaticRootFlow(
          checker,
          declaration.initializer,
          options,
          path,
          nextSeen
        );
      }
    }
    return { kind: "none" };
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const key = staticRootFlowMemberKey(current);
    if (key === null) {
      const base = resolveStaticRootFlow(
        checker,
        current.expression,
        options,
        [],
        new Set(seenSymbols)
      );
      return base.kind === "none"
        ? { kind: "none" }
        : {
            kind: "ambiguous",
            ...(base.root ? { root: base.root } : {}),
            path
          };
    }
    const assigned = resolveStaticMemberValue(checker, current);
    let assignedMayBeRooted = false;
    if (assigned.kind !== "none") {
      const candidates = assigned.kind === "resolved"
        ? [assigned.expression]
        : assigned.expressions;
      const resolved = candidates.map((candidate) =>
        resolveStaticRootFlow(
          checker,
          candidate,
          options,
          path,
          new Set(seenSymbols)
        )
      );
      assignedMayBeRooted = assigned.kind === "unsupported" &&
        resolved.some((entry) => entry.kind !== "none");
      const merged = mergeStaticRootFlowResolutions(resolved);
      if (assigned.kind === "resolved" && merged.kind !== "none") return merged;
    }
    const inherited = resolveStaticRootFlow(
      checker,
      current.expression,
      options,
      [{ kind: "property", key }, ...path],
      seenSymbols
    );
    return inherited.kind !== "none"
      ? inherited
      : assignedMayBeRooted
        ? { kind: "ambiguous", path }
        : { kind: "none" };
  }

  if (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === "slice"
  ) {
    const argument = current.arguments[0]
      ? unwrapStaticExpression(current.arguments[0])
      : null;
    if (!argument || !ts.isNumericLiteral(argument)) {
      const base = resolveStaticRootFlow(
        checker,
        current.expression.expression,
        options,
        [],
        new Set(seenSymbols)
      );
      return base.kind === "none"
        ? { kind: "none" }
        : {
            kind: "ambiguous",
            ...(base.root ? { root: base.root } : {}),
            path
          };
    }
    return resolveStaticRootFlow(
      checker,
      current.expression.expression,
      options,
      [{ kind: "slice", start: Number(argument.text) }, ...path],
      seenSymbols
    );
  }

  if (path.length > 0 && ts.isObjectLiteralExpression(current)) {
    const [head, ...tail] = path;
    if (head.kind === "object_rest") {
      const selected = tail[0];
      if (
        selected?.kind === "property" &&
        head.excluded.includes(selected.key)
      ) {
        return { kind: "none" };
      }
      return resolveStaticRootFlow(
        checker,
        current,
        options,
        tail,
        seenSymbols
      );
    }
    if (head.kind !== "property") return { kind: "ambiguous", path };
    const candidates: ts.Expression[] = [];
    let uncertain = false;
    for (const property of current.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = resolveStaticRootFlow(
          checker,
          property.expression,
          options,
          path,
          new Set(seenSymbols)
        );
        if (spread.kind !== "none") {
          if (spread.kind === "resolved") {
            candidates.push(property.expression);
          }
          uncertain = spread.kind === "ambiguous" || uncertain;
        }
        continue;
      }
      if (
        !ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property)
      ) {
        continue;
      }
      const key = staticCommandBindingPropertyName(current.getSourceFile(), property.name);
      if (key === null) {
        if (
          ts.isPropertyAssignment(property) &&
          staticRootFlowMayContainRoot(checker, property.initializer, options)
        ) {
          uncertain = true;
        }
        continue;
      }
      if (key !== head.key) continue;
      candidates.push(
        ts.isPropertyAssignment(property) ? property.initializer : property.name
      );
    }
    if (uncertain || candidates.length > 1) {
      const candidateRoots = candidates.map((candidate) =>
        resolveStaticRootFlow(checker, candidate, options, tail, new Set(seenSymbols))
      );
      const spreadRoots = current.properties
        .filter(ts.isSpreadAssignment)
        .map((property) =>
          resolveStaticRootFlow(
            checker,
            property.expression,
            options,
            path,
            new Set(seenSymbols)
          )
        );
      return ambiguousStaticRootFlow([...candidateRoots, ...spreadRoots], path);
    }
    if (candidates[0]) {
      const direct = current.properties.find(
        (property) =>
          (ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)) &&
          staticCommandBindingPropertyName(current.getSourceFile(), property.name) === head.key
      );
      return direct
        ? resolveStaticRootFlow(checker, candidates[0], options, tail, seenSymbols)
        : resolveStaticRootFlow(checker, candidates[0], options, path, seenSymbols);
    }
    for (const property of current.properties) {
      if (!ts.isSpreadAssignment(property)) continue;
      const spread = resolveStaticRootFlow(
        checker,
        property.expression,
        options,
        path,
        new Set(seenSymbols)
      );
      if (spread.kind !== "none") return spread;
    }
    return { kind: "none" };
  }

  if (path.length > 0 && ts.isArrayLiteralExpression(current)) {
    const [head, ...tail] = path;
    const requestedIndex = head.kind === "property" && /^\d+$/.test(head.key)
      ? Number(head.key)
      : null;
    if (head.kind === "slice") {
      if (tail.length === 0) {
        const candidates = current.elements
          .slice(head.start)
          .filter(ts.isExpression)
          .map((element) =>
            resolveStaticRootFlow(checker, element, options, [], new Set(seenSymbols))
          );
        return candidates.some((entry) => entry.kind !== "none")
          ? ambiguousStaticRootFlow(candidates, path)
          : { kind: "none" };
      }
      const [next, ...remaining] = tail;
      if (next.kind !== "property" || !/^\d+$/.test(next.key)) {
        return { kind: "ambiguous", path };
      }
      return resolveStaticArrayElementRoot(
        checker,
        current,
        head.start + Number(next.key),
        options,
        remaining,
        seenSymbols
      );
    }
    if (requestedIndex === null) return { kind: "ambiguous", path };
    return resolveStaticArrayElementRoot(
      checker,
      current,
      requestedIndex,
      options,
      tail,
      seenSymbols
    );
  }

  if (path.length === 0 && ts.isObjectLiteralExpression(current)) {
    const roots = current.properties.flatMap((property) => {
      if (ts.isPropertyAssignment(property) || ts.isSpreadAssignment(property)) {
        return [resolveStaticRootFlow(
          checker,
          ts.isPropertyAssignment(property) ? property.initializer : property.expression,
          options,
          [],
          new Set(seenSymbols)
        )];
      }
      return ts.isShorthandPropertyAssignment(property)
        ? [resolveStaticRootFlow(
          checker,
          property.name,
          options,
          [],
          new Set(seenSymbols)
        )]
        : [];
    });
    return roots.some((entry) => entry.kind !== "none")
      ? ambiguousStaticRootFlow(roots)
      : { kind: "none" };
  }

  if (path.length === 0 && ts.isArrayLiteralExpression(current)) {
    const roots = current.elements
      .filter(ts.isExpression)
      .map((element) =>
        resolveStaticRootFlow(checker, element, options, [], new Set(seenSymbols))
      );
    return roots.some((entry) => entry.kind !== "none")
      ? ambiguousStaticRootFlow(roots)
      : { kind: "none" };
  }

  return { kind: "none" };
}

function staticIdentifierValueSymbol(
  checker: ts.TypeChecker,
  identifier: ts.Identifier
): ts.Symbol | undefined {
  return ts.isShorthandPropertyAssignment(identifier.parent) &&
    identifier.parent.name === identifier
    ? checker.getShorthandAssignmentValueSymbol(identifier.parent) ??
      checker.getSymbolAtLocation(identifier)
    : checker.getSymbolAtLocation(identifier);
}

function mergeStaticRootFlowResolutions(
  resolutions: readonly StaticRootFlowResolution[]
): StaticRootFlowResolution {
  const relevant = resolutions
    .filter((entry) => entry.kind !== "none")
    .filter((entry, index, entries) =>
      entries.findIndex((candidate) =>
        stableJson(candidate) === stableJson(entry)
      ) === index
    );
  if (relevant.length === 0) return { kind: "none" };
  if (relevant.length !== 1 || relevant[0].kind === "ambiguous") {
    return ambiguousStaticRootFlow(relevant);
  }
  return relevant[0];
}

function ambiguousStaticRootFlow(
  resolutions: readonly StaticRootFlowResolution[],
  fallbackPath?: readonly StaticRootFlowSegment[]
): StaticRootFlowResolution {
  const candidate = resolutions.find((entry) => entry.kind !== "none");
  return {
    kind: "ambiguous",
    ...(candidate && candidate.root
      ? { root: candidate.root }
      : {}),
    ...(fallbackPath
      ? { path: fallbackPath }
      : candidate && candidate.path
        ? { path: candidate.path }
        : {})
  };
}

function staticRootFlowMemberKey(
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression
): string | null {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (!expression.argumentExpression) return null;
  return resolveStaticCommandLiteral(
    expression.getSourceFile(),
    expression.argumentExpression
  )?.value ?? (
    ts.isNumericLiteral(unwrapStaticExpression(expression.argumentExpression))
      ? (unwrapStaticExpression(expression.argumentExpression) as ts.NumericLiteral).text
      : null
  );
}

function staticBindingElementSource(
  declaration: ts.BindingElement
):
  | {
      readonly kind: "resolved";
      readonly source: ts.Expression;
      readonly path: readonly StaticRootFlowSegment[];
    }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" } {
  const path: StaticRootFlowSegment[] = [];
  let current: ts.BindingElement = declaration;
  while (true) {
    const pattern = current.parent;
    if (ts.isObjectBindingPattern(pattern)) {
      if (current.dotDotDotToken) {
        const excluded = pattern.elements
          .filter((element) => element !== current && !element.dotDotDotToken)
          .map((element) => staticCommandBindingPropertyName(
            declaration.getSourceFile(),
            element.propertyName ??
              (ts.isIdentifier(element.name) ? element.name : undefined)
          ));
        if (excluded.some((key) => key === null)) return { kind: "ambiguous" };
        path.unshift({
          kind: "object_rest",
          excluded: excluded.filter((key): key is string => key !== null)
        });
      } else {
      const key = staticCommandBindingPropertyName(
        declaration.getSourceFile(),
        current.propertyName ?? (ts.isIdentifier(current.name) ? current.name : undefined)
      );
      if (key === null) return { kind: "ambiguous" };
      path.unshift({ kind: "property", key });
      }
    } else if (ts.isArrayBindingPattern(pattern)) {
      const index = pattern.elements.indexOf(current);
      path.unshift(
        current.dotDotDotToken
          ? { kind: "slice", start: index }
          : { kind: "property", key: String(index) }
      );
    } else {
      return { kind: "none" };
    }
    const owner = pattern.parent;
    if (ts.isBindingElement(owner)) {
      current = owner;
      continue;
    }
    if (ts.isVariableDeclaration(owner) && owner.initializer) {
      return { kind: "resolved", source: owner.initializer, path };
    }
    return { kind: "none" };
  }
}

function staticParameterBindingElementSource(
  declaration: ts.BindingElement
):
  | {
      readonly kind: "resolved";
      readonly parameter: ts.ParameterDeclaration;
      readonly path: readonly StaticRootFlowSegment[];
    }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" } {
  const path: StaticRootFlowSegment[] = [];
  let current: ts.BindingElement = declaration;
  while (true) {
    const pattern = current.parent;
    if (ts.isObjectBindingPattern(pattern)) {
      if (current.dotDotDotToken) {
        const excluded = pattern.elements
          .filter((element) => element !== current && !element.dotDotDotToken)
          .map((element) => staticCommandBindingPropertyName(
            declaration.getSourceFile(),
            element.propertyName ??
              (ts.isIdentifier(element.name) ? element.name : undefined)
          ));
        if (excluded.some((key) => key === null)) return { kind: "ambiguous" };
        path.unshift({
          kind: "object_rest",
          excluded: excluded.filter((key): key is string => key !== null)
        });
      } else {
      const key = staticCommandBindingPropertyName(
        declaration.getSourceFile(),
        current.propertyName ??
          (ts.isIdentifier(current.name) ? current.name : undefined)
      );
      if (key === null) return { kind: "ambiguous" };
      path.unshift({ kind: "property", key });
      }
    } else if (ts.isArrayBindingPattern(pattern)) {
      const index = pattern.elements.indexOf(current);
      path.unshift(
        current.dotDotDotToken
          ? { kind: "slice", start: index }
          : { kind: "property", key: String(index) }
      );
    } else {
      return { kind: "none" };
    }
    const owner = pattern.parent;
    if (ts.isBindingElement(owner)) {
      current = owner;
      continue;
    }
    return ts.isParameter(owner)
      ? { kind: "resolved", parameter: owner, path }
      : { kind: "none" };
  }
}

function resolveStaticParameterRootFlow(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
  options: StaticRootFlowOptions,
  path: readonly StaticRootFlowSegment[],
  seenSymbols: ReadonlySet<ts.Symbol>
): StaticRootFlowResolution {
  const callable = parameter.parent;
  if (
    !ts.isFunctionDeclaration(callable) &&
    !ts.isFunctionExpression(callable) &&
    !ts.isArrowFunction(callable) &&
    !ts.isMethodDeclaration(callable)
  ) {
    return { kind: "none" };
  }
  const parameterIndex = callable.parameters.indexOf(parameter);
  if (parameterIndex < 0) return { kind: "none" };
  const resolutions: StaticRootFlowResolution[] = [];
  const sourceFile = callable.getSourceFile();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (declaration === callable) {
        resolutions.push(...resolveStaticCallParameterRoots(
          checker,
          node,
          parameter,
          parameterIndex,
          options,
          path,
          seenSymbols
        ));
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (resolutions.length === 0 && parameter.initializer) {
    resolutions.push(resolveStaticRootFlow(
      checker,
      parameter.initializer,
      options,
      path,
      new Set(seenSymbols)
    ));
  }
  return mergeStaticRootFlowResolutions(resolutions);
}

function resolveStaticCallParameterRoots(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  parameter: ts.ParameterDeclaration,
  parameterIndex: number,
  options: StaticRootFlowOptions,
  path: readonly StaticRootFlowSegment[],
  seenSymbols: ReadonlySet<ts.Symbol>
): readonly StaticRootFlowResolution[] {
  if (parameter.dotDotDotToken) {
    if (path.length === 0) {
      const roots = call.arguments.slice(parameterIndex).map((argument) =>
        ts.isSpreadElement(argument)
          ? ({ kind: "ambiguous" } as const)
          : resolveStaticRootFlow(
              checker,
              argument,
              options,
              [],
              new Set(seenSymbols)
            )
      );
      return roots.some((entry) => entry.kind !== "none")
        ? [ambiguousStaticRootFlow(roots)]
        : [];
    }
    const [head, ...tail] = path;
    if (head.kind === "property" && /^\d+$/.test(head.key)) {
      const argument = call.arguments[parameterIndex + Number(head.key)];
      if (!argument) return [];
      return [ts.isSpreadElement(argument)
        ? { kind: "ambiguous" }
        : resolveStaticRootFlow(
            checker,
            argument,
            options,
            tail,
            new Set(seenSymbols)
          )];
    }
    if (head.kind === "slice") {
      const roots = call.arguments
        .slice(parameterIndex + head.start)
        .map((argument) =>
          ts.isSpreadElement(argument)
            ? ({ kind: "ambiguous" } as const)
            : resolveStaticRootFlow(
                checker,
                argument,
                options,
                tail,
                new Set(seenSymbols)
              )
        );
      return roots.some((entry) => entry.kind !== "none")
        ? [ambiguousStaticRootFlow(roots, path)]
        : [];
    }
    return [{ kind: "ambiguous" }];
  }

  const argument = call.arguments[parameterIndex];
  const useDefault = !argument || (
    ts.isIdentifier(unwrapStaticExpression(argument)) &&
    (unwrapStaticExpression(argument) as ts.Identifier).text === "undefined"
  );
  if (useDefault) {
    return parameter.initializer
      ? [resolveStaticRootFlow(
          checker,
          parameter.initializer,
          options,
          path,
          new Set(seenSymbols)
        )]
      : [];
  }
  return [ts.isSpreadElement(argument)
    ? { kind: "ambiguous" }
    : resolveStaticRootFlow(
        checker,
        argument,
        options,
        path,
        new Set(seenSymbols)
      )];
}

function resolveStaticArrayElementRoot(
  checker: ts.TypeChecker,
  array: ts.ArrayLiteralExpression,
  index: number,
  options: StaticRootFlowOptions,
  path: readonly StaticRootFlowSegment[],
  seenSymbols: ReadonlySet<ts.Symbol>
): StaticRootFlowResolution {
  if (array.elements.some(ts.isSpreadElement)) return { kind: "ambiguous" };
  const element = array.elements[index];
  return element && ts.isExpression(element)
    ? resolveStaticRootFlow(
        checker,
        element,
        options,
        path,
        new Set(seenSymbols)
      )
    : { kind: "none" };
}

function staticRootFlowMayContainRoot(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  options: StaticRootFlowOptions,
  seenSymbols = new Set<ts.Symbol>()
): boolean {
  const resolved = resolveStaticRootFlow(
    checker,
    expression,
    options,
    [],
    seenSymbols
  );
  if (resolved.kind !== "none") return true;
  const current = unwrapStaticExpression(expression);
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      node !== current &&
      ts.isIdentifier(node) &&
      options.identifyRoot(node)
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(current, visit);
  return found;
}

type StaticMemberAssignmentTarget = {
  readonly root: ts.Identifier;
  readonly rootSymbol: ts.Symbol;
  readonly parts: readonly string[];
  readonly computed: boolean;
};

function resolveStaticMemberValue(
  checker: ts.TypeChecker,
  expression: ts.Expression
): StaticVariableValue {
  const target = staticMemberAssignmentTarget(checker, expression);
  if (!target) return { kind: "none" };
  const initialMember = resolveDeclaredStaticMemberValue(
    checker,
    target.rootSymbol,
    target.parts
  );
  const expressions: ts.Expression[] = initialMember ? [initialMember] : [];
  let unsupportedWrite = target.computed;
  const sourceFile = target.root.getSourceFile();
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const writtenRoot = memberRootIdentifier(node.left);
      if (
        writtenRoot &&
        checker.getSymbolAtLocation(writtenRoot) === target.rootSymbol
      ) {
        const written = staticMemberAssignmentTarget(checker, node.left);
        const exact = Boolean(
          written &&
          !written.computed &&
          sameMemberPath(written.parts, target.parts)
        );
        const replacesPrefix = Boolean(
          written &&
          !written.computed &&
          written.parts.length < target.parts.length &&
          isMemberPathPrefix(written.parts, target.parts)
        );
        if (exact && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          expressions.push(node.right);
        } else if (target.computed || !written || written.computed || exact || replacesPrefix) {
          unsupportedWrite = true;
          if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            expressions.push(node.right);
          }
        }
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      nodeContainsSymbol(checker, node.operand, target.rootSymbol)
    ) {
      unsupportedWrite = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (unsupportedWrite || expressions.length > 1) {
    return { kind: "unsupported", expressions };
  }
  return expressions[0]
    ? { kind: "resolved", expression: expressions[0] }
    : { kind: "none" };
}

function staticMemberAssignmentTarget(
  checker: ts.TypeChecker,
  expression: ts.Expression
): StaticMemberAssignmentTarget | null {
  const root = memberRootIdentifier(expression);
  if (!root) return null;
  const rootSymbol = checker.getSymbolAtLocation(root);
  if (!rootSymbol) return null;
  const member = staticMemberPath(expression);
  return {
    root,
    rootSymbol,
    parts: member?.parts ?? [],
    computed: !member || memberChainContainsElementAccess(expression)
  };
}

function memberRootIdentifier(expression: ts.Expression): ts.Identifier | null {
  let current = unwrapStaticExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapStaticExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current : null;
}

function memberChainContainsElementAccess(expression: ts.Expression): boolean {
  let current = unwrapStaticExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isElementAccessExpression(current)) return true;
    current = unwrapStaticExpression(current.expression);
  }
  return false;
}

function sameMemberPath(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function isMemberPathPrefix(
  prefix: readonly string[],
  target: readonly string[]
): boolean {
  return prefix.every((part, index) => part === target[index]);
}

function resolveStaticVariableValue(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration
): StaticVariableValue {
  if (!ts.isIdentifier(declaration.name)) return { kind: "none" };
  const variableSymbol = checker.getSymbolAtLocation(declaration.name);
  if (!variableSymbol) return { kind: "none" };
  const expressions: ts.Expression[] = declaration.initializer
    ? [declaration.initializer]
    : [];
  let unsupportedWrite = false;
  const sourceFile = declaration.getSourceFile();
  const visit = (node: ts.Node) => {
    if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const direct = ts.isIdentifier(node.left) &&
        checker.getSymbolAtLocation(node.left) === variableSymbol;
      if (direct) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          expressions.push(node.right);
        } else {
          unsupportedWrite = true;
        }
      } else if (nodeContainsSymbol(checker, node.left, variableSymbol)) {
        const destructured = node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          ? resolveDestructuringAssignmentValue(
              checker,
              node.left,
              node.right,
              variableSymbol
            )
          : null;
        if (destructured) expressions.push(destructured);
        else unsupportedWrite = true;
      }
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      nodeContainsSymbol(checker, node.operand, variableSymbol)
    ) {
      unsupportedWrite = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  if (unsupportedWrite || expressions.length > 1) {
    return { kind: "unsupported", expressions };
  }
  return expressions[0]
    ? { kind: "resolved", expression: expressions[0] }
    : { kind: "none" };
}

function resolveDeclaredStaticMemberValue(
  checker: ts.TypeChecker,
  rootSymbol: ts.Symbol,
  parts: readonly string[],
  seen = new Set<ts.Symbol>()
): ts.Expression | null {
  if (seen.has(rootSymbol)) return null;
  seen.add(rootSymbol);
  const declaration = rootSymbol.valueDeclaration ?? rootSymbol.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return null;
  }
  return resolveStaticLiteralPath(checker, declaration.initializer, parts, seen);
}

function resolveStaticLiteralPath(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  parts: readonly string[],
  seen = new Set<ts.Symbol>()
): ts.Expression | null {
  const current = unwrapStaticExpression(expression);
  if (parts.length === 0) return current;
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    return symbol
      ? resolveDeclaredStaticMemberValue(checker, symbol, parts, seen)
      : null;
  }
  const [head, ...tail] = parts;
  if (ts.isObjectLiteralExpression(current)) {
    const property = current.properties.find(
      (entry) =>
        (ts.isPropertyAssignment(entry) || ts.isShorthandPropertyAssignment(entry)) &&
        !ts.isComputedPropertyName(entry.name) &&
        propertyName(entry.name) === head
    );
    if (!property) return null;
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      return null;
    }
    const value = ts.isPropertyAssignment(property)
      ? property.initializer
      : property.name;
    return resolveStaticLiteralPath(checker, value, tail, seen);
  }
  if (ts.isArrayLiteralExpression(current) && /^\d+$/.test(head)) {
    const element = current.elements[Number(head)];
    return element && ts.isExpression(element)
      ? resolveStaticLiteralPath(checker, element, tail, seen)
      : null;
  }
  return null;
}

function resolveDestructuringAssignmentValue(
  checker: ts.TypeChecker,
  pattern: ts.Expression,
  source: ts.Expression,
  targetSymbol: ts.Symbol
): ts.Expression | null {
  const current = unwrapStaticExpression(pattern);
  const value = unwrapStaticExpression(source);
  if (ts.isObjectLiteralExpression(current)) {
    for (const property of current.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        if (checker.getSymbolAtLocation(property.name) !== targetSymbol) continue;
        return resolveStaticLiteralPath(checker, value, [property.name.text]);
      }
      if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) {
        continue;
      }
      if (!nodeContainsSymbol(checker, property.initializer, targetSymbol)) continue;
      const key = propertyName(property.name);
      return key ? resolveStaticLiteralPath(checker, value, [key]) : null;
    }
    return null;
  }
  if (ts.isArrayLiteralExpression(current)) {
    const index = current.elements.findIndex((element) =>
      ts.isExpression(element) && nodeContainsSymbol(checker, element, targetSymbol)
    );
    return index >= 0
      ? resolveStaticLiteralPath(checker, value, [String(index)])
      : null;
  }
  return null;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function nodeContainsSymbol(
  checker: ts.TypeChecker,
  root: ts.Node,
  symbol: ts.Symbol
): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function hasPotentialBetterAuthAssignment(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  repositoryRoot: string
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return false;
  const value = resolveStaticVariableValue(checker, declaration);
  if (value.kind === "none") return false;
  const expressions = value.kind === "resolved" ? [value.expression] : value.expressions;
  return expressions.some((expression) =>
    expressionMayAliasBetterAuth(checker, expression, repositoryRoot)
  );
}

function expressionMayAliasBetterAuth(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string
): boolean {
  const current = unwrapStaticExpression(expression);
  if (ts.isAwaitExpression(current) || ts.isCallExpression(current)) return false;
  if (resolveBetterAuthCallBinding(checker, current, repositoryRoot)) return true;
  return expressionContainsBetterAuthRoot(checker, current, repositoryRoot);
}

function expressionContainsBetterAuthRoot(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string
): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      isBetterAuthClientRoot(checker, node, repositoryRoot)
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

function resolveServerActionExport(
  checker: ts.TypeChecker,
  exported: ts.Symbol,
  repositoryRoot: string
): { readonly target: string; readonly declaration: ts.Declaration } | null {
  const targetSymbol = (exported.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(exported)
    : exported;
  const declaration = targetSymbol.valueDeclaration ?? targetSymbol.declarations?.[0];
  if (!declaration) return null;
  const isDirectFunction =
    ts.isFunctionDeclaration(declaration) ||
    (ts.isVariableDeclaration(declaration) &&
      Boolean(
        declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
      ));
  if (!isDirectFunction) return null;
  const sourceFile = declaration.getSourceFile();
  if (!resolve(sourceFile.fileName).startsWith(resolve(repositoryRoot))) return null;
  return {
    target: `${relativeModule(repositoryRoot, sourceFile.fileName)}#${targetSymbol.getName()}`,
    declaration
  };
}

function resolveImportedServerAction(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  repositoryRoot: string
): string | null {
  const local = staticIdentifierValueSymbol(checker, identifier);
  if (!local) return null;
  const target = (local.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(local)
    : resolveDynamicImportBindingSymbol(checker, local) ?? local;
  if (!target) return null;
  const declaration = target.valueDeclaration ?? target.declarations?.[0];
  if (!declaration) return null;
  const isDirectFunction = isFunctionLikeWithBlock(declaration) ||
    (ts.isVariableDeclaration(declaration) &&
      Boolean(
        declaration.initializer &&
        (ts.isArrowFunction(unwrapStaticExpression(declaration.initializer)) ||
          ts.isFunctionExpression(unwrapStaticExpression(declaration.initializer)))
      ));
  if (!isDirectFunction) return null;
  const sourceFile = declaration.getSourceFile();
  if (!resolve(sourceFile.fileName).startsWith(resolve(repositoryRoot))) return null;
  const moduleAction = hasUseServerDirective(sourceFile.statements);
  const inlineAction =
    isFunctionLikeWithBlock(declaration) && hasUseServerDirective(declaration.body.statements);
  if (!moduleAction && !inlineAction) return null;
  return `${relativeModule(repositoryRoot, sourceFile.fileName)}#${target.getName()}`;
}

function resolveClientServerActionBinding(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string,
  seen = new Set<ts.Symbol>(),
  seenMembers = new Set<string>()
): string | null {
  const current = unwrapStaticExpression(expression);
  const directTargets = new Map<string, string>();
  const namespaceTargets = new Map<string, ts.Symbol>();
  const staticRoot = resolveStaticRootFlow(checker, current, {
    identifyRoot: (identifier) => {
      const direct = resolveImportedServerAction(checker, identifier, repositoryRoot);
      if (direct) {
        const root = `server_action:${direct}`;
        directTargets.set(root, direct);
        return root;
      }
      const namespace = importedServerActionNamespaceSymbol(
        checker,
        identifier,
        repositoryRoot
      );
      if (!namespace) return null;
      const declaration = namespace.declarations?.[0];
      const root = `server_action_namespace:${
        declaration
          ? relativeModule(repositoryRoot, declaration.getSourceFile().fileName)
          : namespace.getName()
      }`;
      namespaceTargets.set(root, namespace);
      return root;
    }
  });
  if (staticRoot.kind === "resolved") {
    const direct = directTargets.get(staticRoot.root);
    if (direct && staticRoot.path.length === 0) return direct;
    const namespace = namespaceTargets.get(staticRoot.root);
    if (
      namespace &&
      staticRoot.path.length === 1 &&
      staticRoot.path[0].kind === "property"
    ) {
      const exported = checker.getExportsOfModule(namespace).find(
        (entry) => entry.getName() ===
          (staticRoot.path[0] as Extract<StaticRootFlowSegment, { kind: "property" }>).key
      );
      if (exported) {
        return resolveServerActionExport(checker, exported, repositoryRoot)?.target ?? null;
      }
    }
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const namespaceTarget = resolveServerActionNamespaceMember(
      checker,
      current,
      repositoryRoot
    );
    if (namespaceTarget) return namespaceTarget;
    const member = staticMemberPath(current);
    const rootSymbol = member ? checker.getSymbolAtLocation(member.root) : undefined;
    const memberKey = rootSymbol && member
      ? `${rootSymbol.valueDeclaration?.getStart() ?? rootSymbol.getName()}:${member.parts.join(".")}`
      : null;
    if (memberKey && !seenMembers.has(memberKey)) {
      seenMembers.add(memberKey);
      const value = resolveStaticMemberValue(checker, current);
      if (value.kind === "resolved") {
        return resolveClientServerActionBinding(
          checker,
          value.expression,
          repositoryRoot,
          seen,
          seenMembers
        );
      }
    }
  }
  if (!ts.isIdentifier(current)) return null;
  const imported = resolveImportedServerAction(checker, current, repositoryRoot);
  if (imported) return imported;
  const symbol = checker.getSymbolAtLocation(current);
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration && ts.isBindingElement(declaration)) {
    return resolveBindingElementServerAction(
      checker,
      declaration,
      repositoryRoot
    );
  }
  if (!declaration || !ts.isVariableDeclaration(declaration)) return null;
  const value = resolveStaticVariableValue(checker, declaration);
  if (value.kind === "resolved") {
    return resolveClientServerActionBinding(
        checker,
        value.expression,
        repositoryRoot,
        seen,
        seenMembers
      );
  }
  return resolveAssignedServerActionBinding(
    checker,
    symbol,
    repositoryRoot
  );
}

function importedServerActionNamespaceSymbol(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  repositoryRoot: string
): ts.Symbol | null {
  const local = staticIdentifierValueSymbol(checker, identifier);
  const declaration = local?.declarations?.find(ts.isNamespaceImport);
  if (!local || !declaration) return null;
  const moduleSymbol = (local.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(local)
    : null;
  if (!moduleSymbol) return null;
  return checker.getExportsOfModule(moduleSymbol).some((entry) =>
    Boolean(resolveServerActionExport(checker, entry, repositoryRoot))
  )
    ? moduleSymbol
    : null;
}

function resolveServerActionNamespaceMember(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string,
  appendedParts: readonly string[] = [],
  seen = new Set<ts.Symbol>()
): string | null {
  const current = unwrapStaticExpression(expression);
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const member = staticMemberPath(current);
    if (!member) return null;
    return resolveServerActionNamespaceMember(
      checker,
      member.root,
      repositoryRoot,
      [...member.parts, ...appendedParts],
      seen
    );
  }
  if (!ts.isIdentifier(current)) return null;
  const symbol = checker.getSymbolAtLocation(current);
  if (!symbol || seen.has(symbol)) return null;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration && ts.isNamespaceImport(declaration)) {
    if (appendedParts.length !== 1) return null;
    const moduleSymbol = (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : null;
    const exported = moduleSymbol
      ? checker.getExportsOfModule(moduleSymbol).find(
          (entry) => entry.getName() === appendedParts[0]
        )
      : undefined;
    return exported
      ? resolveServerActionExport(checker, exported, repositoryRoot)?.target ?? null
      : null;
  }
  if (declaration && ts.isVariableDeclaration(declaration)) {
    const value = resolveStaticVariableValue(checker, declaration);
    if (value.kind === "resolved") {
      return resolveServerActionNamespaceMember(
        checker,
        value.expression,
        repositoryRoot,
        appendedParts,
        seen
      );
    }
  }
  return appendedParts.length === 0
    ? resolveImportedServerAction(checker, current, repositoryRoot)
    : null;
}

function isServerActionNamespaceExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string,
  seen = new Set<ts.Symbol>()
): boolean {
  const current = unwrapStaticExpression(expression);
  if (!ts.isIdentifier(current)) return false;
  const symbol = checker.getSymbolAtLocation(current);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (declaration && ts.isNamespaceImport(declaration)) {
    const moduleSymbol = (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : null;
    return Boolean(
      moduleSymbol && checker.getExportsOfModule(moduleSymbol).some((entry) =>
        Boolean(resolveServerActionExport(checker, entry, repositoryRoot))
      )
    );
  }
  if (declaration && ts.isVariableDeclaration(declaration)) {
    const value = resolveStaticVariableValue(checker, declaration);
    return value.kind === "resolved" && isServerActionNamespaceExpression(
      checker,
      value.expression,
      repositoryRoot,
      seen
    );
  }
  return false;
}

function resolveBindingElementServerAction(
  checker: ts.TypeChecker,
  declaration: ts.BindingElement,
  repositoryRoot: string
): string | null {
  if (!ts.isObjectBindingPattern(declaration.parent)) return null;
  const variable = declaration.parent.parent;
  if (!ts.isVariableDeclaration(variable) || !variable.initializer) return null;
  const key = staticCommandBindingPropertyName(
    declaration.getSourceFile(),
    declaration.propertyName ??
      (ts.isIdentifier(declaration.name) ? declaration.name : undefined)
  );
  return key
    ? resolveServerActionNamespaceMember(
        checker,
        variable.initializer,
        repositoryRoot,
        [key]
      )
    : null;
}

function resolveAssignedServerActionBinding(
  checker: ts.TypeChecker,
  targetSymbol: ts.Symbol,
  repositoryRoot: string
): string | null {
  const targets = new Set(
    collectAssignedServerActionBindings(
      checker,
      targetSymbol,
      repositoryRoot
    ).map((entry) => entry.target)
  );
  return targets.size === 1 ? [...targets][0] : null;
}

function collectAssignedServerActionBindings(
  checker: ts.TypeChecker,
  targetSymbol: ts.Symbol,
  repositoryRoot: string
): readonly {
  readonly target: string;
  readonly node: ts.Identifier;
  readonly source: ts.Expression;
}[] {
  const declaration = targetSymbol.valueDeclaration ?? targetSymbol.declarations?.[0];
  if (!declaration) return [];
  const bindings: Array<{
    readonly target: string;
    readonly node: ts.Identifier;
    readonly source: ts.Expression;
  }> = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      nodeContainsSymbol(checker, node.left, targetSymbol)
    ) {
      const path = destructuringPathToSymbol(
        checker,
        node.left,
        targetSymbol
      );
      if (path) {
        const target = resolveServerActionNamespaceMember(
          checker,
          node.right,
          repositoryRoot,
          path
        );
        const reference = findIdentifierForSymbol(checker, node.left, targetSymbol);
        if (target && reference) {
          bindings.push({ target, node: reference, source: node.right });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(declaration.getSourceFile(), visit);
  return bindings;
}

function findIdentifierForSymbol(
  checker: ts.TypeChecker,
  root: ts.Node,
  symbol: ts.Symbol
): ts.Identifier | null {
  let found: ts.Identifier | null = null;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
      found = node;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function destructuringPathToSymbol(
  checker: ts.TypeChecker,
  pattern: ts.Expression,
  targetSymbol: ts.Symbol
): readonly string[] | null {
  const current = unwrapStaticExpression(pattern);
  if (ts.isIdentifier(current)) {
    return checker.getSymbolAtLocation(current) === targetSymbol ? [] : null;
  }
  if (ts.isObjectLiteralExpression(current)) {
    for (const property of current.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        if (checker.getSymbolAtLocation(property.name) === targetSymbol) {
          return [property.name.text];
        }
        continue;
      }
      if (!ts.isPropertyAssignment(property)) continue;
      const key = staticCommandBindingPropertyName(current.getSourceFile(), property.name);
      if (!key) continue;
      const tail = destructuringPathToSymbol(
        checker,
        property.initializer,
        targetSymbol
      );
      if (tail) return [key, ...tail];
    }
  }
  if (ts.isArrayLiteralExpression(current)) {
    for (let index = 0; index < current.elements.length; index += 1) {
      const element = current.elements[index];
      if (!ts.isExpression(element)) continue;
      const tail = destructuringPathToSymbol(checker, element, targetSymbol);
      if (tail) return [String(index), ...tail];
    }
  }
  return null;
}

function mayAliasImportedServerAction(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string,
  seen = new Set<ts.Symbol>()
): boolean {
  const current = unwrapStaticExpression(expression);
  if (ts.isCallExpression(current) || ts.isAwaitExpression(current)) return false;
  if (resolveClientServerActionBinding(checker, current, repositoryRoot)) return true;
  const memberValue = resolveStaticMemberValue(checker, current);
  if (memberValue.kind !== "none") {
    const expressions = memberValue.kind === "resolved"
      ? [memberValue.expression]
      : memberValue.expressions;
    if (
      expressions.some((candidate) =>
        mayAliasImportedServerAction(
          checker,
          candidate,
          repositoryRoot,
          new Set(seen)
        )
      )
    ) {
      return true;
    }
  }
  if (ts.isIdentifier(current)) {
    const symbol = checker.getSymbolAtLocation(current);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = resolveStaticVariableValue(checker, declaration);
      const expressions = value.kind === "resolved"
        ? [value.expression]
        : value.kind === "unsupported"
          ? value.expressions
          : [];
      return expressions.some((candidate) =>
        mayAliasImportedServerAction(
          checker,
          candidate,
          repositoryRoot,
          new Set(seen)
        )
      );
    }
  }
  return containsImportedServerAction(checker, current, repositoryRoot);
}

function containsImportedServerAction(
  checker: ts.TypeChecker,
  node: ts.Node,
  repositoryRoot: string
): boolean {
  if (ts.isExpression(node)) {
    const root = resolveStaticRootFlow(checker, node, {
      identifyRoot: (identifier) => {
        const direct = resolveImportedServerAction(checker, identifier, repositoryRoot);
        if (direct) return `server_action:${direct}`;
        return importedServerActionNamespaceSymbol(checker, identifier, repositoryRoot)
          ? "server_action_namespace"
          : null;
      }
    });
    if (
      root.kind !== "none" &&
      (root.root?.startsWith("server_action:") ||
        root.root === "server_action_namespace")
    ) {
      return true;
    }
  }
  let found = false;
  const visit = (current: ts.Node) => {
    if (
      current !== node &&
      ts.isIdentifier(current) &&
      resolveImportedServerAction(checker, current, repositoryRoot)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(current, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function isPotentialDelegatedClientBindingArgument(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ownerSource: ts.SourceFile,
  repositoryRoot: string
): boolean {
  const current = unwrapStaticExpression(expression);
  if (ts.isCallExpression(current) || ts.isAwaitExpression(current)) {
    return false;
  }
  if (
    resolveGlobalFetchBinding(checker, current, ownerSource) ||
    looksLikeFetchBinding(checker, current, ownerSource) ||
    resolveBetterAuthCallBinding(checker, current, repositoryRoot) ||
    looksLikeDelegatedBetterAuthMethod(checker, current, repositoryRoot)
  ) {
    return true;
  }
  if (
    ts.isIdentifier(current) &&
    resolveClientServerActionBinding(checker, current, repositoryRoot)
  ) {
    return true;
  }
  return mayAliasImportedServerAction(checker, current, repositoryRoot);
}

function looksLikeDelegatedBetterAuthMethod(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  repositoryRoot: string
): boolean {
  const current = unwrapStaticExpression(expression);
  if (ts.isCallExpression(current) || ts.isAwaitExpression(current)) return false;
  if (staticMemberValueMayAliasBetterAuth(checker, current, repositoryRoot)) {
    return true;
  }
  if (ts.isIdentifier(current)) {
    return hasPotentialBetterAuthAssignment(checker, current, repositoryRoot);
  }
  const root = memberRootIdentifier(current);
  if (root && isBetterAuthClientRoot(checker, root, repositoryRoot)) {
    return true;
  }
  let found = false;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) return;
    if (
      node !== current &&
      ts.isExpression(node) &&
      (resolveBetterAuthCallBinding(checker, node, repositoryRoot) ||
        (memberRootIdentifier(node as ts.Expression) &&
          isBetterAuthClientRoot(
            checker,
            memberRootIdentifier(node as ts.Expression)!,
            repositoryRoot
          )))
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(current, visit);
  return found;
}

function containsDelegatedClientBindingCall(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ownerSource: ts.SourceFile,
  repositoryRoot: string
): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.some((argument) =>
        isPotentialDelegatedClientBindingArgument(
          checker,
          argument,
          ownerSource,
          repositoryRoot
        )
      )
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(expression);
  return found;
}

type SensitiveClientReferenceKind =
  | "global_fetch"
  | "better_auth_method"
  | "server_action";

type SensitiveClientReference = {
  readonly node: ts.Node;
  readonly kind: SensitiveClientReferenceKind;
};

function collectDirectSensitiveClientReferences(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  repositoryRoot: string
): readonly SensitiveClientReference[] {
  const references: SensitiveClientReference[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isBindingElement(node)) {
      const kind = bindingElementSensitiveKind(
        checker,
        node,
        sourceFile,
        repositoryRoot
      );
      if (kind) references.push({ node, kind });
    }
    if (ts.isExpression(node) && isRuntimeExpressionReference(node)) {
      const kind = directSensitiveClientReferenceKind(
        checker,
        node,
        sourceFile,
        repositoryRoot
      );
      if (kind) {
        if (!isDestructuringBindingInitializer(node)) {
          references.push({ node, kind });
        }
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return references;
}

function isDestructuringBindingInitializer(expression: ts.Expression): boolean {
  const parent = expression.parent;
  return Boolean(
    parent &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    (ts.isObjectBindingPattern(parent.name) || ts.isArrayBindingPattern(parent.name))
  );
}

function traceSensitiveClientSources(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ownerSource: ts.SourceFile,
  repositoryRoot: string,
  seenSymbols = new Set<ts.Symbol>(),
  seenMembers = new Set<string>()
): readonly SensitiveClientReference[] {
  const current = unwrapStaticExpression(expression);
  const directKind = directSensitiveClientReferenceKind(
    checker,
    current,
    ownerSource,
    repositoryRoot
  );
  if (directKind) return [{ node: current, kind: directKind }];

  if (ts.isIdentifier(current)) {
    const symbol = staticIdentifierValueSymbol(checker, current);
    if (!symbol || seenSymbols.has(symbol)) return [];
    seenSymbols.add(symbol);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    if (declaration && ts.isParameter(declaration)) {
      return traceStaticParameterSensitiveSources(
        checker,
        declaration,
        ownerSource,
        repositoryRoot,
        seenSymbols,
        seenMembers
      );
    }
    if (declaration && ts.isVariableDeclaration(declaration)) {
      const value = resolveStaticVariableValue(checker, declaration);
      const expressions = value.kind === "resolved"
        ? [value.expression]
        : value.kind === "unsupported"
          ? value.expressions
          : [];
      const traced = expressions.flatMap((candidate) => traceSensitiveClientSources(
        checker,
        candidate,
        ownerSource,
        repositoryRoot,
        new Set(seenSymbols),
        new Set(seenMembers)
      ));
      if (traced.length > 0) return traced;
      return collectAssignedServerActionBindings(
        checker,
        symbol,
        repositoryRoot
      ).flatMap(({ node, source }) => {
        const sourceReferences = traceSensitiveClientSources(
          checker,
          source,
          ownerSource,
          repositoryRoot,
          new Set(seenSymbols),
          new Set(seenMembers)
        );
        return [
          { node, kind: "server_action" as const },
          ...sourceReferences
        ];
      });
    }
    if (declaration && ts.isBindingElement(declaration)) {
      const bindingKind = bindingElementSensitiveKind(
        checker,
        declaration,
        ownerSource,
        repositoryRoot
      );
      const variableBinding = staticBindingElementSource(declaration);
      if (variableBinding.kind === "resolved") {
        const traced = traceSensitiveClientSources(
          checker,
          variableBinding.source,
          ownerSource,
          repositoryRoot,
          seenSymbols,
          seenMembers
        );
        if (traced.length > 0) {
          return bindingKind
            ? [{ node: declaration, kind: bindingKind }, ...traced]
            : traced;
        }
      }
      if (bindingKind) return [{ node: declaration, kind: bindingKind }];
      const parameterBinding = staticParameterBindingElementSource(declaration);
      return parameterBinding.kind === "resolved"
        ? traceStaticParameterSensitiveSources(
            checker,
            parameterBinding.parameter,
            ownerSource,
            repositoryRoot,
            seenSymbols,
            seenMembers
          )
        : [];
    }
    return [];
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    const member = staticMemberPath(current);
    const root = member?.root ?? memberRootIdentifier(current);
    const rootSymbol = root ? checker.getSymbolAtLocation(root) : undefined;
    const memberKey = rootSymbol
      ? `${rootSymbol.valueDeclaration?.getStart() ?? rootSymbol.getName()}:${current.getText()}`
      : null;
    if (memberKey && !seenMembers.has(memberKey)) {
      seenMembers.add(memberKey);
      const value = resolveStaticMemberValue(checker, current);
      const expressions = value.kind === "resolved"
        ? [value.expression]
        : value.kind === "unsupported"
          ? value.expressions
          : [];
      if (expressions.length > 0) {
        return expressions.flatMap((candidate) => traceSensitiveClientSources(
          checker,
          candidate,
          ownerSource,
          repositoryRoot,
          new Set(seenSymbols),
          new Set(seenMembers)
        ));
      }
    }
  }

  const references: SensitiveClientReference[] = [];
  const visit = (node: ts.Node) => {
    if (node !== current && ts.isExpression(node)) {
      const traced = traceSensitiveClientSources(
        checker,
        node,
        ownerSource,
        repositoryRoot,
        new Set(seenSymbols),
        new Set(seenMembers)
      );
      if (traced.length > 0) {
        references.push(...traced);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(current, visit);
  return references;
}

function traceStaticParameterSensitiveSources(
  checker: ts.TypeChecker,
  parameter: ts.ParameterDeclaration,
  ownerSource: ts.SourceFile,
  repositoryRoot: string,
  seenSymbols: ReadonlySet<ts.Symbol>,
  seenMembers: ReadonlySet<string>
): readonly SensitiveClientReference[] {
  const callable = parameter.parent;
  if (
    !ts.isFunctionDeclaration(callable) &&
    !ts.isFunctionExpression(callable) &&
    !ts.isArrowFunction(callable) &&
    !ts.isMethodDeclaration(callable)
  ) {
    return [];
  }
  const parameterIndex = callable.parameters.indexOf(parameter);
  if (parameterIndex < 0) return [];
  const references: SensitiveClientReference[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      checker.getResolvedSignature(node)?.declaration === callable
    ) {
      const argumentsForParameter = parameter.dotDotDotToken
        ? node.arguments.slice(parameterIndex)
        : node.arguments.slice(parameterIndex, parameterIndex + 1);
      for (const argument of argumentsForParameter) {
        if (ts.isSpreadElement(argument)) continue;
        references.push(...traceSensitiveClientSources(
          checker,
          argument,
          ownerSource,
          repositoryRoot,
          new Set(seenSymbols),
          new Set(seenMembers)
        ));
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(callable.getSourceFile(), visit);
  return references;
}

function directSensitiveClientReferenceKind(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  ownerSource: ts.SourceFile,
  repositoryRoot: string
): SensitiveClientReferenceKind | null {
  const current = unwrapStaticExpression(expression);
  if (
    ts.isIdentifier(current) &&
    current.text === "fetch" &&
    isGlobalIdentifier(checker, current, ownerSource) &&
    !isPropertyNameIdentifier(current)
  ) {
    return "global_fetch";
  }
  if (
    ts.isIdentifier(current) &&
    (current.text === "globalThis" || current.text === "window") &&
    isGlobalIdentifier(checker, current, ownerSource) &&
    isIdentifierValueReference(current) &&
    !(
      (ts.isPropertyAccessExpression(current.parent) ||
        ts.isElementAccessExpression(current.parent)) &&
      current.parent.expression === current
    )
  ) {
    return "global_fetch";
  }
  if (
    (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) &&
    isDirectGlobalFetchExpression(checker, current, ownerSource)
  ) {
    return "global_fetch";
  }
  const member = staticMemberPath(current);
  if (
    member &&
    member.parts.length > 0 &&
    isBetterAuthClientRoot(checker, member.root, repositoryRoot)
  ) {
    return "better_auth_method";
  }
  if (
    ts.isIdentifier(current) &&
    isIdentifierValueReference(current) &&
    isBetterAuthClientRoot(checker, current, repositoryRoot) &&
    !(
      (ts.isPropertyAccessExpression(current.parent) ||
        ts.isElementAccessExpression(current.parent)) &&
      current.parent.expression === current
    )
  ) {
    return "better_auth_method";
  }
  if (
    ts.isIdentifier(current) &&
    isIdentifierValueReference(current) &&
    (resolveImportedServerAction(checker, current, repositoryRoot) ||
      (isWithinStaticAssignmentTarget(current) &&
        (resolveClientServerActionBinding(checker, current, repositoryRoot) ||
          assignmentUsesServerActionNamespace(
            checker,
            current,
            repositoryRoot
          ))))
  ) {
    return "server_action";
  }
  if (
    (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) &&
    resolveServerActionNamespaceMember(checker, current, repositoryRoot)
  ) {
    return "server_action";
  }
  if (
    ts.isIdentifier(current) &&
    isIdentifierValueReference(current) &&
    importedServerActionNamespaceSymbol(checker, current, repositoryRoot)
  ) {
    return "server_action";
  }
  return null;
}

function bindingElementSensitiveKind(
  checker: ts.TypeChecker,
  declaration: ts.BindingElement,
  ownerSource: ts.SourceFile,
  repositoryRoot: string
): SensitiveClientReferenceKind | null {
  if (!ts.isObjectBindingPattern(declaration.parent)) return null;
  const variable = declaration.parent.parent;
  if (!ts.isVariableDeclaration(variable) || !variable.initializer) return null;
  const name = declaration.propertyName
    ? propertyName(declaration.propertyName)
    : ts.isIdentifier(declaration.name)
      ? declaration.name.text
      : null;
  if (
    name === "fetch" &&
    isGlobalObjectExpression(checker, variable.initializer, ownerSource)
  ) {
    return "global_fetch";
  }
  const member = staticMemberPath(variable.initializer);
  if (
    member &&
    name &&
    isBetterAuthClientRoot(checker, member.root, repositoryRoot)
  ) {
    return "better_auth_method";
  }
  if (resolveBindingElementServerAction(checker, declaration, repositoryRoot)) {
    return "server_action";
  }
  const namespaceVariable = declaration.parent.parent;
  if (
    ts.isVariableDeclaration(namespaceVariable) &&
    namespaceVariable.initializer &&
    isServerActionNamespaceExpression(
      checker,
      namespaceVariable.initializer,
      repositoryRoot
    )
  ) {
    return "server_action";
  }
  return null;
}

function assignmentUsesServerActionNamespace(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  repositoryRoot: string
): boolean {
  let current: ts.Node | undefined = identifier;
  while (current && !ts.isStatement(current)) {
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      identifier.getStart() < current.right.getStart()
    ) {
      const symbol = checker.getSymbolAtLocation(identifier);
      const path = symbol
        ? destructuringPathToSymbol(checker, current.left, symbol)
        : null;
      return Boolean(path && path.length > 0) && isServerActionNamespaceExpression(
        checker,
        current.right,
        repositoryRoot
      );
    }
    current = current.parent;
  }
  return false;
}

function isDirectGlobalFetchExpression(
  checker: ts.TypeChecker,
  expression: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ownerSource: ts.SourceFile
): boolean {
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "fetch" &&
      isGlobalObjectExpression(checker, expression.expression, ownerSource);
  }
  const argument = expression.argumentExpression;
  return Boolean(
    argument &&
    (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
    argument.text === "fetch" &&
    isGlobalObjectExpression(checker, expression.expression, ownerSource)
  );
}

function isRuntimeExpressionReference(node: ts.Expression): boolean {
  let current: ts.Node | undefined = node;
  while (current.parent && !ts.isStatement(current.parent)) {
    if (ts.isTypeNode(current.parent)) return false;
    current = current.parent;
  }
  return true;
}

function isPropertyNameIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (!parent) return false;
  return Boolean(
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
      parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.propertyName === identifier)
  );
}

function isIdentifierValueReference(
  identifier: ts.Identifier,
  explicitParent?: ts.Node
): boolean {
  const parent = explicitParent ?? identifier.parent;
  if (!parent) return false;
  if (
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportClause(parent) ||
    ts.isImportEqualsDeclaration(parent) ||
    ts.isExportSpecifier(parent) ||
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) &&
      (parent.name === identifier || parent.propertyName === identifier)) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
      parent.name === identifier)
  ) {
    return false;
  }
  return isRuntimeExpressionReference(identifier);
}

function isFormAttribute(attribute: ts.JsxAttribute): boolean {
  const attributes = attribute.parent;
  const element = attributes.parent;
  return (
    (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) &&
    ts.isIdentifier(element.tagName) &&
    element.tagName.text === "form"
  );
}

function resolveFormActionTarget(
  checker: ts.TypeChecker,
  identifier: ts.Identifier,
  repositoryRoot: string,
  ownerModule: string,
  ownerSource: ts.SourceFile
): string | null {
  const imported = resolveImportedServerAction(checker, identifier, repositoryRoot);
  if (imported) return imported;
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || declaration.getSourceFile() !== ownerSource) return null;
  if (ts.isFunctionDeclaration(declaration)) return `${ownerModule}#${identifier.text}`;
  if (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
  ) {
    return `${ownerModule}#${identifier.text}`;
  }
  return null;
}

function resolveImportedTarget(
  checker: ts.TypeChecker,
  local: ts.Identifier,
  repositoryRoot: string
): string | null {
  const localSymbol = checker.getSymbolAtLocation(local);
  if (!localSymbol) return null;
  const targetSymbol =
    (localSymbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(localSymbol)
      : localSymbol;
  const declaration = targetSymbol.valueDeclaration ?? targetSymbol.declarations?.[0];
  if (!declaration) return null;
  const sourceFile = declaration.getSourceFile();
  if (!resolve(sourceFile.fileName).startsWith(resolve(repositoryRoot))) return null;
  return `${relativeModule(repositoryRoot, sourceFile.fileName)}#${targetSymbol.getName()}`;
}

function hasDirective(statements: readonly ts.Statement[], directive: string): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      return false;
    }
    if (statement.expression.text === directive) return true;
  }
  return false;
}

function hasUseServerDirective(statements: readonly ts.Statement[]): boolean {
  return hasDirective(statements, "use server");
}

function containsInlineUseServerDirective(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      isFunctionLikeWithBlock(node) &&
      hasUseServerDirective(node.body.statements)
    ) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function containsFormActionAttribute(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "action" &&
      isFormAttribute(node)
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((entry) => entry.kind === kind));
}

function isFunctionLikeWithBlock(
  node: ts.Node
): node is (ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction) & {
  readonly body: ts.Block;
} {
  return (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
    Boolean(node.body && ts.isBlock(node.body))
  );
}

function actionFunctionName(
  node: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text;
  }
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  return null;
}

function actionObservation(
  ownerModule: string,
  symbol: string,
  node: ts.Node,
  sourceFile: ts.SourceFile
): StructuralObservation {
  return {
    kind: "server_action",
    ownerModule,
    symbol,
    target: `${ownerModule}#${symbol}`,
    anchorFile: ownerModule,
    anchorStart: node.getStart(sourceFile),
    anchorEnd: node.getEnd()
  };
}

function resolveRouteExport(
  checker: ts.TypeChecker,
  exported: ts.Symbol,
  ownerSource: ts.SourceFile,
  repositoryRoot: string,
  method: string
): { readonly target: string; readonly declaration: ts.Declaration } | null {
  if ((exported.flags & ts.SymbolFlags.Alias) !== 0) {
    const targetSymbol = checker.getAliasedSymbol(exported);
    const declaration = targetSymbol.valueDeclaration ?? targetSymbol.declarations?.[0];
    if (!declaration) return null;
    const targetFile = declaration.getSourceFile();
    return {
      target: `${relativeModule(repositoryRoot, targetFile.fileName)}#${targetSymbol.getName()}`,
      declaration
    };
  }

  const declaration = exported.valueDeclaration ?? exported.declarations?.[0];
  if (!declaration) return null;
  if (ts.isFunctionDeclaration(declaration)) {
    return {
      target: `${relativeModule(repositoryRoot, declaration.getSourceFile().fileName)}#${declaration.name?.text ?? method}`,
      declaration
    };
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const initializer = unwrapParentheses(declaration.initializer);
    if (ts.isPropertyAccessExpression(initializer)) {
      const frameworkTarget = resolveFrameworkHandlerTarget(checker, initializer);
      if (frameworkTarget) return { target: frameworkTarget, declaration };
    }
    if (ts.isIdentifier(initializer)) {
      const aliasSymbol = checker.getSymbolAtLocation(initializer);
      const aliasDeclaration = aliasSymbol?.valueDeclaration ?? aliasSymbol?.declarations?.[0];
      if (aliasDeclaration && ts.isFunctionDeclaration(aliasDeclaration)) {
        return {
          target: `${relativeModule(repositoryRoot, aliasDeclaration.getSourceFile().fileName)}#${aliasSymbol?.getName()}`,
          declaration
        };
      }
    }
  }
  return null;
}

function resolveFrameworkHandlerTarget(
  checker: ts.TypeChecker,
  access: ts.PropertyAccessExpression
): string | null {
  if (!ts.isIdentifier(access.expression)) return null;
  const binding = checker.getSymbolAtLocation(access.expression);
  const declaration = binding?.valueDeclaration ?? binding?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
    return null;
  }
  const initializer = unwrapParentheses(declaration.initializer);
  if (!ts.isCallExpression(initializer) || !ts.isIdentifier(initializer.expression)) return null;
  const factorySymbol = checker.getSymbolAtLocation(initializer.expression);
  const importSpecifier = factorySymbol?.declarations?.find(ts.isImportSpecifier);
  const importDeclaration = importSpecifier ? containingImportDeclaration(importSpecifier) : null;
  const moduleSpecifier = importDeclaration?.moduleSpecifier;
  if (
    !importSpecifier ||
    !importDeclaration ||
    !moduleSpecifier ||
    !ts.isStringLiteral(moduleSpecifier) ||
    moduleSpecifier.text !== "better-auth/next-js" ||
    initializer.expression.text !== "toNextJsHandler"
  ) {
    return null;
  }
  return `better-auth/next-js#toNextJsHandler.${access.name.text}`;
}

function relativeModule(repositoryRoot: string, fileName: string): string {
  return relative(repositoryRoot, fileName).replaceAll("\\", "/");
}

export function parseSidecarSource(fileName: string, sourceText: string): ParsedSidecar {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const unsupported = (detail: string): ParsedSidecar => ({
    diagnostics: [{ code: "unsupported_sidecar_syntax", file: fileName, detail }],
    declarations: []
  });

  const parseDiagnostics = (sourceFile as ts.SourceFile & {
    readonly parseDiagnostics: readonly ts.Diagnostic[];
  }).parseDiagnostics;
  if (parseDiagnostics.length > 0) return unsupported("typescript_parse_error");

  const declarationStatements: ts.VariableStatement[] = [];
  let schemaImportCount = 0;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleName = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : "";
      if (
        !statement.importClause?.isTypeOnly ||
        moduleName !== "@/server/operation-registry/schema"
      ) {
        return unsupported("only_registry_type_imports_are_allowed");
      }
      schemaImportCount += 1;
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      declarationStatements.push(statement);
      continue;
    }
    return unsupported("only_one_exported_literal_declaration_is_allowed");
  }

  if (schemaImportCount !== 1) {
    return unsupported("exactly_one_schema_type_import_is_required");
  }

  if (declarationStatements.length !== 1) {
    return unsupported("exactly_one_declaration_is_required");
  }
  const statement = declarationStatements[0];
  const isExported = statement.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  );
  const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
  if (!isExported || !isConst || statement.declarationList.declarations.length !== 1) {
    return unsupported("declaration_must_be_one_exported_const");
  }

  const variable = statement.declarationList.declarations[0];
  if (!ts.isIdentifier(variable.name) || !variable.initializer) {
    return unsupported("declaration_name_or_initializer_is_unsupported");
  }
  if (!ts.isSatisfiesExpression(variable.initializer)) {
    return unsupported("declaration_must_use_satisfies");
  }
  if (!variable.initializer.type.getText(sourceFile).includes("OperationDeclaration")) {
    return unsupported("declaration_must_satisfy_operation_schema");
  }

  const asserted = unwrapParentheses(variable.initializer.expression);
  if (
    !ts.isAsExpression(asserted) ||
    asserted.type.getText(sourceFile) !== "const"
  ) {
    return unsupported("declaration_must_be_const_asserted");
  }

  const literal = readLiteral(unwrapParentheses(asserted.expression));
  if (!literal.ok) return unsupported(literal.detail);
  const values = Array.isArray(literal.value) ? literal.value : [literal.value];
  const declarations: OperationDeclaration[] = [];
  for (const value of values) {
    const validated = validateDeclaration(value);
    if (!validated.ok) {
      return {
        diagnostics: [{ code: "invalid_sidecar_schema", file: fileName, detail: validated.detail }],
        declarations: []
      };
    }
    declarations.push(validated.value);
  }
  if (declarations.length === 0) {
    return {
      diagnostics: [{ code: "invalid_sidecar_schema", file: fileName, detail: "empty_declaration_array" }],
      declarations: []
    };
  }
  return { diagnostics: [], declarations };
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

type LiteralResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly detail: string };

function readLiteral(expression: ts.Expression): LiteralResult {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return { ok: true, value: expression.text };
  }
  if (ts.isNumericLiteral(expression)) return { ok: true, value: Number(expression.text) };
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
  if (expression.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
  if (ts.isArrayLiteralExpression(expression)) {
    const output: unknown[] = [];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) return { ok: false, detail: "spread_is_not_literal" };
      const item = readLiteral(unwrapParentheses(element));
      if (!item.ok) return item;
      output.push(item.value);
    }
    return { ok: true, value: output };
  }
  if (ts.isObjectLiteralExpression(expression)) {
    const output: Record<string, unknown> = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property) || property.name === undefined) {
        return { ok: false, detail: "object_member_is_not_a_literal_property" };
      }
      if (ts.isComputedPropertyName(property.name)) {
        return { ok: false, detail: "computed_property_is_not_literal" };
      }
      const key = propertyName(property.name);
      if (key === null || Object.hasOwn(output, key)) {
        return { ok: false, detail: "property_name_is_invalid_or_duplicate" };
      }
      const item = readLiteral(unwrapParentheses(property.initializer));
      if (!item.ok) return item;
      output[key] = item.value;
    }
    return { ok: true, value: output };
  }
  return { ok: false, detail: "initializer_contains_executable_or_non_literal_syntax" };
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

const ownerKinds = new Set<OperationOwnerKind>([
  "api_route",
  "server_loader",
  "client_binding",
  "server_action",
  "instrumentation",
  "worker",
  "package_command"
]);

const bindingKinds = new Set<StructuralBindingKind>([
  "route_method",
  "server_value_import",
  "server_dynamic_import",
  "server_action",
  "form_action",
  "global_fetch",
  "auth_client_call",
  "worker_dynamic_import",
  "worker_static_import",
  "worker_start_call",
  "worker_tick",
  "worker_schedule",
  "package_script",
  "package_build_entrypoint",
  "package_build_invocation",
  "container_copy",
  "container_invocation",
  "command_variant"
]);

function validateDeclaration(value: unknown):
  | { readonly ok: true; readonly value: OperationDeclaration }
  | { readonly ok: false; readonly detail: string } {
  if (!isRecord(value)) return { ok: false, detail: "declaration_must_be_object" };
  const allowed = new Set([
    "schemaVersion",
    "id",
    "ownerModule",
    "ownerKind",
    "bindings",
    "disposition",
    "exclusion",
    "deferredGateIds"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { ok: false, detail: "unknown_declaration_property" };
  }
  if (
    value.schemaVersion !== 1 ||
    !isNonBlankString(value.id) ||
    !isNonBlankString(value.ownerModule) ||
    typeof value.ownerKind !== "string" ||
    !ownerKinds.has(value.ownerKind as OperationOwnerKind) ||
    !Array.isArray(value.bindings) ||
    (value.disposition !== "observed" && value.disposition !== "excluded") ||
    !Array.isArray(value.deferredGateIds) ||
    !value.deferredGateIds.every(isNonBlankString)
  ) {
    return { ok: false, detail: "declaration_shape_is_invalid" };
  }
  for (const binding of value.bindings) {
    if (
      !isRecord(binding) ||
      Object.keys(binding).sort().join(",") !== "kind,symbol,target" ||
      typeof binding.kind !== "string" ||
      !bindingKinds.has(binding.kind as StructuralBindingKind) ||
      !isNonBlankString(binding.symbol) ||
      !isNonBlankString(binding.target)
    ) {
      return { ok: false, detail: "binding_shape_is_invalid" };
    }
  }
  if (value.exclusion !== undefined) {
    if (
      !isRecord(value.exclusion) ||
      Object.keys(value.exclusion).sort().join(",") !== "category,rationale" ||
      !["rehearsal", "fixture", "build_tool", "registry_tooling"].includes(
        String(value.exclusion.category)
      ) ||
      !isNonBlankString(value.exclusion.rationale)
    ) {
      return { ok: false, detail: "exclusion_shape_is_invalid" };
    }
  }
  if (value.disposition === "observed" && value.exclusion !== undefined) {
    return { ok: false, detail: "observed_declaration_forbids_exclusion" };
  }
  if (value.disposition === "excluded" && value.exclusion === undefined) {
    return { ok: false, detail: "excluded_declaration_requires_exclusion" };
  }
  return { ok: true, value: value as OperationDeclaration };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
