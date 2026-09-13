import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("health route contract", () => {
  it("loads browser-operation integrity inside the fail-closed handler boundary", () => {
    const route = readFileSync(resolve(process.cwd(), "src/app/api/health/route.ts"), "utf8");

    expect(route).not.toContain('import { verifyBrowserOperationInfrastructure } from "@/server/services/browser-operation-integrity";');
    expect(route).not.toContain('import { NextResponse } from "next/server";');
    expect(route).toContain('process.env.CUBBY_P13_ACCEPTANCE_HEALTH_SENTINEL === "1"');
    expect(route).toContain("return new Response(null, { status: 204 });");
    expect(route.indexOf("CUBBY_P13_ACCEPTANCE_HEALTH_SENTINEL")).toBeLessThan(
      route.indexOf('await import("@/server/services/browser-operation-integrity")')
    );
    expect(route).toContain('const { verifyBrowserOperationInfrastructure } = await import("@/server/services/browser-operation-integrity");');
    expect(route).toContain('return Response.json({ status: "ready" }, responseInit);');
    expect(route).toContain("status: 503");
  });
});
