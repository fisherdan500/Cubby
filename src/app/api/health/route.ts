export const dynamic = "force-dynamic";
const responseInit = { headers: { "Cache-Control": "no-store" } };

export async function GET() {
  if (process.env.CUBBY_P13_ACCEPTANCE_HEALTH_SENTINEL === "1") {
    return new Response(null, { status: 204 });
  }
  try {
    const { verifyBrowserOperationInfrastructure } = await import("@/server/services/browser-operation-integrity");
    await verifyBrowserOperationInfrastructure();
    return Response.json({ status: "ready" }, responseInit);
  } catch {
    return Response.json(
      { status: "unavailable" },
      { ...responseInit, status: 503 }
    );
  }
}
