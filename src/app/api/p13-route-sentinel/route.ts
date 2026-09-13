import { writeFileSync } from "node:fs";

export const dynamic = "force-dynamic";

const moduleMarkerPath = "/run/cubby-acceptance-status/route-module";
const handlerMarkerPath = "/run/cubby-acceptance-status/route-handler";

if (
  process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL === "1"
  && process.env.CUBBY_P13_ACCEPTANCE_ROUTE_MODULE_MARKER === moduleMarkerPath
) {
  writeFileSync(moduleMarkerPath, "evaluated\n", { encoding: "utf8", flag: "w", mode: 0o600 });
}

export function GET() {
  if (process.env.CUBBY_P13_ACCEPTANCE_ROUTE_SENTINEL === "1") {
    if (process.env.CUBBY_P13_ACCEPTANCE_ROUTE_HANDLER_MARKER === handlerMarkerPath) {
      writeFileSync(handlerMarkerPath, "entered\n", { encoding: "utf8", flag: "w", mode: 0o600 });
    }
    return new Response(null, { status: 204 });
  }
  return new Response(null, { status: 404 });
}
