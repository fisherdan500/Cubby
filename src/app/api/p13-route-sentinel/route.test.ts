import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({ writeFileSync: vi.fn() }));

vi.mock("node:fs", () => fsMocks);

const originalSentinel = process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL;
const originalModuleMarker = process.env.CUBBY_P13_ACCEPTANCE_ROUTE_MODULE_MARKER;
const originalHandlerMarker = process.env.CUBBY_P13_ACCEPTANCE_ROUTE_HANDLER_MARKER;
const moduleMarkerPath = "/run/cubby-acceptance-status/route-module";
const handlerMarkerPath = "/run/cubby-acceptance-status/route-handler";

afterEach(() => {
  if (originalSentinel === undefined) delete process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL;
  else process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL = originalSentinel;
  if (originalModuleMarker === undefined) delete process.env.CUBBY_P13_ACCEPTANCE_ROUTE_MODULE_MARKER;
  else process.env.CUBBY_P13_ACCEPTANCE_ROUTE_MODULE_MARKER = originalModuleMarker;
  if (originalHandlerMarker === undefined) delete process.env.CUBBY_P13_ACCEPTANCE_ROUTE_HANDLER_MARKER;
  else process.env.CUBBY_P13_ACCEPTANCE_ROUTE_HANDLER_MARKER = originalHandlerMarker;
  fsMocks.writeFileSync.mockReset();
  vi.resetModules();
});

describe("P1-3 acceptance route sentinel", () => {
  it("permits repeated requests without an exclusive-create failure", async () => {
    const files = new Set<string>();
    fsMocks.writeFileSync.mockImplementation((file, _value, options) => {
      if (files.has(file) && options.flag === "wx") throw Object.assign(new Error("synthetic"), { code: "EEXIST" });
      files.add(file);
    });
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL = "1";
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_HANDLER_MARKER = handlerMarkerPath;
    const { GET } = await import("./route");
    expect(GET().status).toBe(204);
    expect(GET().status).toBe(204);
  });
  it("is absent outside the generated isolated acceptance environment", async () => {
    delete process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL;
    const { GET } = await import("./route");
    expect((await GET()).status).toBe(404);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("writes fixed module and handler markers before its body-free status", async () => {
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL = "1";
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_MODULE_MARKER = moduleMarkerPath;
    process.env.CUBBY_P13_ACCEPTANCE_ROUTE_HANDLER_MARKER = handlerMarkerPath;
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(fsMocks.writeFileSync.mock.calls).toEqual([
      [moduleMarkerPath, "evaluated\n", { encoding: "utf8", flag: "w", mode: 0o600 }],
      [handlerMarkerPath, "entered\n", { encoding: "utf8", flag: "w", mode: 0o600 }]
    ]);
  });
});
