import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type RegistryModule = typeof import("../src/server/operation-registry/checker");
type RegistryDiagnostic = ReturnType<RegistryModule["checkRepositoryArtifacts"]>[number];

const registry = await import(
  new URL("../src/server/operation-registry/checker.ts", import.meta.url).href
) as RegistryModule;

const [mode, ...rest] = process.argv.slice(2);
if (rest.length > 0 || (mode !== "--write" && mode !== "--check")) {
  process.stderr.write("operation_registry_usage: expected --write or --check\n");
  process.exitCode = 1;
} else if (mode === "--write") {
  const result = registry.writeRepositoryArtifacts(process.cwd());
  const semantic = registry.buildSemanticRepositoryArtifacts(process.cwd());
  const diagnostics = [...result.diagnostics, ...semantic.diagnostics];
  if (diagnostics.length > 0) {
    writeDiagnostics(diagnostics);
    process.exitCode = 1;
  } else {
    for (const [file, content] of Object.entries(semantic.artifacts)) {
      const target = resolve(process.cwd(), file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    process.stdout.write(
      `operation_registry_generated owners=${result.registry.owners.length} declarations=${result.registry.declarations.length} omissions=${result.registry.omissionLedger.length}\n`
    );
  }
} else {
  const legacyDiagnostics = registry.checkRepositoryArtifacts(process.cwd());
  const semantic = registry.buildSemanticRepositoryArtifacts(process.cwd());
  const semanticDiagnostics = semantic.diagnostics.length > 0
    ? semantic.diagnostics
    : registry.checkSemanticGeneratedArtifacts(process.cwd(), semantic.artifacts);
  const diagnostics = [...legacyDiagnostics, ...semanticDiagnostics];
  if (diagnostics.length > 0) {
    writeDiagnostics(diagnostics);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      "operation_registry_check_passed structural_authority=observation_only semantic_authority=source_reviewed_subset semantic_complete=false\n"
    );
  }
}

function writeDiagnostics(
  diagnostics: readonly RegistryDiagnostic[]
) {
  for (const diagnostic of diagnostics) {
    process.stderr.write(
      `${diagnostic.code}\t${diagnostic.file}\t${diagnostic.detail}\n`
    );
  }
}
