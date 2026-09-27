import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createEmailDeliveryCipher } from "@/server/services/email-change-delivery";
import { composeInvitationEmail, invitationEmailAvailable, invitationEmailDeliveryId, invitationEmailLink, prepareInvitationEmailDelivery } from "@/server/services/invitation-email";
import type { createInvitationServices } from "@/server/services/invitation-service";
import { DEFAULT_APP_TIMEZONE } from "@/lib/timezone";

type Services = Pick<ReturnType<typeof createInvitationServices>, "manualEmail">;
type Request = Parameters<Services["manualEmail"]["enqueue"]>[0]["request"];
type Dependencies = { database: Pick<PrismaClient, "invite">; environment: Record<string, string | undefined> };

async function defaultDependencies(): Promise<Dependencies> {
  const { prisma } = await import("@/lib/db/prisma");
  return { database: prisma, environment: process.env as Record<string, string | undefined> };
}

/**
 * Queues the issuer-requested email for a just-created or replaced invitation. It never throws: the invitation already
 * exists and its display-once link is still shown, so any failure is reported as `not_queued` for a later re-send.
 */
export async function queueManualInvitationEmail(input: { services: Services; operationId: string; operationKind: "MANUAL_INVITE_CREATE" | "MANUAL_INVITE_REPLACE"; target: string; householdId: string; inviteToken: string; request: Request }, dependencies?: Dependencies): Promise<"queued" | "not_queued"> {
  try {
    const { database, environment } = dependencies ?? await defaultDependencies();
    if (!invitationEmailAvailable(environment) || !environment.BETTER_AUTH_URL) return "not_queued";
    // Protocol v2 stores the plain hex digest of the display-once token.
    const tokenHash = createHash("sha256").update(input.inviteToken, "utf8").digest("hex");
    const invite = await database.invite.findFirst({
      where: { tokenHash, householdId: input.householdId, status: "pending" },
      select: { id: true, email: true, expiresAt: true, household: { select: { name: true } }, invitedBy: { select: { name: true } } }
    });
    if (!invite) return "not_queued";
    const message = composeInvitationEmail({ recipient: invite.email, householdName: invite.household.name, inviterName: invite.invitedBy.name, link: invitationEmailLink(environment.BETTER_AUTH_URL, input.inviteToken), expiresAt: invite.expiresAt, timeZone: environment.APP_TIMEZONE?.trim() || DEFAULT_APP_TIMEZONE });
    const delivery = prepareInvitationEmailDelivery(createEmailDeliveryCipher(environment), { deliveryId: invitationEmailDeliveryId(), inviteId: invite.id, operationId: input.operationId, message });
    const receipt = await input.services.manualEmail.enqueue({ operationId: input.operationId, operationKind: input.operationKind, target: input.target, tokenHash, delivery, request: input.request });
    return receipt && typeof receipt === "object" && (receipt as { status?: unknown }).status === "queued" ? "queued" : "not_queued";
  } catch {
    return "not_queued";
  }
}
