import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireUser } from "@/server/auth/session";
import { PLATFORM_SINGLETON_ID } from "@/server/services/platform-constants";

export { PLATFORM_SINGLETON_ID } from "@/server/services/platform-constants";

const platformRegistrationSettingsSchema = z.object({
  householdCreationMode: z.enum(["closed", "invitation_only", "open"]),
  allowPublicRegistration: z.boolean()
});

export type PlatformOwnerContext = {
  userId: string;
  authorityId: typeof PLATFORM_SINGLETON_ID;
};

export async function isPlatformOwner(userId: string) {
  const authority = await prisma.platformAuthority.findFirst({
    where: { id: PLATFORM_SINGLETON_ID, ownerUserId: userId },
    select: { id: true, ownerUserId: true }
  });
  return Boolean(authority);
}

export async function getPlatformOwnerContext(): Promise<PlatformOwnerContext> {
  const user = await requireUser();
  const authority = await prisma.platformAuthority.findFirst({
    where: { id: PLATFORM_SINGLETON_ID, ownerUserId: user.id },
    select: { id: true, ownerUserId: true }
  });
  if (!authority) throw new Error("forbidden");
  return { userId: user.id, authorityId: PLATFORM_SINGLETON_ID };
}

export async function getPlatformRegistrationSettings() {
  await getPlatformOwnerContext();
  const settings = await prisma.platformSettings.findUnique({
    where: { id: PLATFORM_SINGLETON_ID }
  });
  if (!settings) throw new Error("platform_uninitialized");
  return settings;
}

export async function updatePlatformRegistrationSettings(raw: unknown) {
  const user = await requireUser();
  const input = platformRegistrationSettingsSchema.parse(raw);

  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id"
        FROM "PlatformAuthority"
        WHERE "id" = ${PLATFORM_SINGLETON_ID}
        FOR UPDATE`;
      const authority = await tx.platformAuthority.findFirst({
        where: { id: PLATFORM_SINGLETON_ID, ownerUserId: user.id },
        select: { id: true, ownerUserId: true }
      });
      if (!authority) throw new Error("forbidden");

      await tx.$queryRaw`SELECT "id"
        FROM "PlatformSettings"
        WHERE "id" = ${PLATFORM_SINGLETON_ID}
        FOR UPDATE`;
      const before = await tx.platformSettings.findUnique({
        where: { id: PLATFORM_SINGLETON_ID }
      });
      if (!before) throw new Error("platform_uninitialized");

      const after = await tx.platformSettings.update({
        where: { id: PLATFORM_SINGLETON_ID },
        data: input
      });
      await tx.platformAuditEvent.create({
        data: {
          actorUserId: user.id,
          action: "platform.registration.update",
          entityType: "platform_settings",
          entityId: PLATFORM_SINGLETON_ID,
          source: "application",
          before: {
            householdCreationMode: before.householdCreationMode,
            allowPublicRegistration: before.allowPublicRegistration
          },
          after: input
        }
      });
      return after;
    },
    { isolationLevel: "Serializable" }
  );
}
