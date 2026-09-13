"use strict";

try {
  const fileSystem = process.getBuiltinModule("fs");
  const stages = Object.freeze([
    "preload_file_loaded",
    "preload_guards_confirmed",
    "standalone_server_module_entered",
    "next_package_loaded",
    "start_server_module_loaded",
    "start_server_invoked",
    "next_server_module_loaded",
    "instrumentation_module_load_requested"
  ]);
  const stageFile = "/run/cubby-acceptance-status/instrumentation-stage";
  if (fileSystem && typeof fileSystem.writeFileSync === "function") {
    const standaloneServer = "/app/server.js";
    const nextServerModule = "/app/node_modules/next/dist/server/next.js";
    const instrumentationModule = "/app/.next/server/instrumentation.js";
    const instrumentationRequest = "/app/.next/server/instrumentation";
    let stageIndex = -1;
    const observedStages = new Set();
    let instrumentationRequested = false;
    const advance = (stage) => {
      if (instrumentationRequested) return;
      const nextIndex = stages.indexOf(stage);
      if (nextIndex < 0) return;
      observedStages.add(nextIndex);
      while (observedStages.has(stageIndex + 1)) {
        fileSystem.writeFileSync(stageFile, `${stages[stageIndex + 1]}\n`, {
          encoding: "utf8",
          flag: "w",
          mode: 0o600
        });
        stageIndex += 1;
      }
    };

    advance("preload_file_loaded");

    const Module = process.getBuiltinModule("module");
    const guardsConfirmed = process.env.CUBBY_P13_ACCEPTANCE_INSTRUMENTATION_STAGE_FILE === stageFile
      && process.cwd() === "/app"
      && Module
      && typeof Module._load === "function"
      && typeof Module.prototype?._compile === "function";

    if (!guardsConfirmed) return;
    advance("preload_guards_confirmed");

    const originalCompile = Module.prototype._compile;
    Module.prototype._compile = function compileWithStandaloneEntry(content, filename) {
      if (filename === standaloneServer) advance("standalone_server_module_entered");
      return Reflect.apply(originalCompile, this, [content, filename]);
    };

    const originalLoad = Module._load;
    Module._load = function loadWithBootstrapStages(request, parent, isMain) {
      if (request === instrumentationModule || request === instrumentationRequest) {
        advance("instrumentation_module_load_requested");
        // Instrumentation owns the same stage file from this point onward.
        instrumentationRequested = true;
        return Reflect.apply(originalLoad, this, [request, parent, isMain]);
      }

      const loaded = Reflect.apply(originalLoad, this, [request, parent, isMain]);
      if (parent?.filename === standaloneServer && request === "next") {
        advance("next_package_loaded");
      }
      if (parent?.filename === standaloneServer && request === "next/dist/server/lib/start-server") {
        advance("start_server_module_loaded");
        const wrapped = Object.create(loaded);
        Object.defineProperty(wrapped, "startServer", {
          enumerable: true,
          value(...args) {
            advance("start_server_invoked");
            return Reflect.apply(loaded.startServer, loaded, args);
          }
        });
        return wrapped;
      }
      if (parent?.filename === nextServerModule && request === "./next-server") {
        advance("next_server_module_loaded");
      }
      return loaded;
    };
  }
} catch {
  // The fixed stage file is the only diagnostic surface.
}
