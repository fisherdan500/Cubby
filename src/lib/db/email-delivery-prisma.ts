import { PrismaClient } from "@prisma/client";

function emailDeliveryDatabaseUrl() {
  const raw = process.env.EMAIL_DELIVERY_DATABASE_URL;
  try {
    if (!raw) throw new Error();
    const parsed = new URL(raw);
    if (decodeURIComponent(parsed.username) !== "cubby_email_delivery" || !parsed.password) throw new Error();
    return raw;
  } catch {
    throw new Error("email_delivery_database_unavailable");
  }
}

const globalForEmailDelivery = globalThis as unknown as { emailDeliveryPrisma?: PrismaClient };

export const emailDeliveryPrisma = globalForEmailDelivery.emailDeliveryPrisma ?? new PrismaClient({
  datasourceUrl: emailDeliveryDatabaseUrl(),
  log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"]
});

if (process.env.NODE_ENV !== "production") globalForEmailDelivery.emailDeliveryPrisma = emailDeliveryPrisma;
