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
  if (result.diagnostics.length > 0) {
    writeDiagnostics(result.diagnostics);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `operation_registry_generated owners=${result.registry.owners.length} declarations=${result.registry.declarations.length} omissions=${result.registry.omissionLedger.length}\n`
    );
  }
} else {
  const diagnostics = registry.checkRepositoryArtifacts(process.cwd());
  if (diagnostics.length > 0) {
    writeDiagnostics(diagnostics);
    process.exitCode = 1;
  } else {
    process.stdout.write("operation_registry_check_passed authority=observation_only\n");
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
