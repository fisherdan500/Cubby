import { NextResponse } from "next/server";
import { verifyBrowserOperationInfrastructure } from "@/server/services/browser-operation-integrity";

export const dynamic = "force-dynamic";
const responseInit = { headers: { "Cache-Control": "no-store" } };

export async function GET() {
  try {
    await verifyBrowserOperationInfrastructure();
    return NextResponse.json({ status: "ready" }, responseInit);
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { ...responseInit, status: 503 }
    );
  }
}
