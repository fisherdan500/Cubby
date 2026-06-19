import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashSecret } from "@/lib/auth/password";
import { getHouseholdContext, requirePermission } from "@/server/auth/context";
import { handleError, ok } from "@/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await getHouseholdContext();
    requirePermission(ctx, "session.manage");
    const devices = await prisma.trustedDevice.findMany({
      where: { userId: ctx.userId, deletedAt: null },
      orderBy: { updatedAt: "desc" }
    });
    return ok(devices.map(({ pinHash: _pinHash, ...device }) => device));
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getHouseholdContext();
    requirePermission(ctx, "session.manage");
    const body = await request.json();
    const pin = String(body.pin ?? "");
    if (!/^\d{4,8}$/.test(pin)) {
      return NextResponse.json(
        { ok: false, error: { code: "invalid_pin", message: "PIN must be 4 to 8 digits." } },
        { status: 422 }
      );
    }
    const device = await prisma.trustedDevice.create({
      data: {
        householdId: ctx.householdId,
        userId: ctx.userId,
        label: String(body.label || "Trusted phone"),
        pinHash: hashSecret(pin),
        lastUsedAt: new Date()
      }
    });
    const { pinHash: _pinHash, ...safeDevice } = device;
    return ok(safeDevice, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}
