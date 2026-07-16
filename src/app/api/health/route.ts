import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

export const dynamic = "force-dynamic";
const responseInit = { headers: { "Cache-Control": "no-store" } };

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ready" }, responseInit);
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { ...responseInit, status: 503 }
    );
  }
}
