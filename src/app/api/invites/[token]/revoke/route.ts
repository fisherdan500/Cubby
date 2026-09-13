import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, _context: unknown) {
  return NextResponse.json({ ok: true, data: { status: "unavailable" } }, { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
