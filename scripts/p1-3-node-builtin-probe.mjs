const fileSystem = process.getBuiltinModule("fs");

if (!fileSystem || typeof fileSystem.writeFileSync !== "function") {
  process.exitCode = 1;
}
