import { createHash, randomBytes } from "node:crypto";
import { createEmailDeliveryCipher } from "@/server/services/email-change-delivery";
import { smtpEmailDeliveryConfigured } from "@/server/services/smtp-email-delivery";
import { formatInstant } from "@/lib/timezone";
import { singleMailbox } from "@/lib/validation/email";

type Environment = Record<string, string | undefined>;
type Cipher = ReturnType<typeof createEmailDeliveryCipher>;
export type InvitationEmailMessage = { recipient: string; subject: string; text: string };

/** The AAD `kind` for household invitations; the shared cipher's other binding fields carry invitation identities. */
export const INVITATION_EMAIL_KIND = "household_invitation";

export function invitationEmailAvailable(environment: Environment = process.env as Environment) {
  if (!smtpEmailDeliveryConfigured(environment)) return false;
  try { createEmailDeliveryCipher(environment); return true; } catch { return false; }
}

/** Matches the database's `digest(lower(btrim(email)))`, which the enqueue procedure recomputes from the Invite. */
export function invitationRecipientDigest(email: string) {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest();
}

export function invitationEmailLink(baseUrl: string, token: string) {
  return `${new URL(baseUrl).origin}/invite#c=${encodeURIComponent(token)}`;
}

function headerSafe(value: string) {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function composeInvitationEmail(input: { recipient: string; householdName: string; inviterName: string; link: string; expiresAt: Date; timeZone: string }): InvitationEmailMessage {
  const household = headerSafe(input.householdName) || "a household";
  const inviter = headerSafe(input.inviterName) || "Someone";
  const text = [
    `${inviter} invited you to join ${household} on Cubby.`,
    "",
    "Open this link to set up your account and accept the invitation:",
    input.link,
    "",
    `The link works once and expires ${formatInstant(input.expiresAt, input.timeZone, { withYear: true })}.`,
    "",
    "If you were not expecting this invitation, you can ignore this email."
  ].join("\n");
  return { recipient: singleMailbox(input.recipient).toLowerCase(), subject: `${inviter} invited you to ${household} on Cubby`, text };
}

export function invitationEmailBinding(input: { deliveryId: string; inviteId: string; operationId: string; recipientDigest: Buffer }) {
  if (input.operationId.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId)) throw new Error("invitation_operation_invalid");
  // PostgreSQL UUID output is lowercase; authenticate the same bytes on both sides.
  return { deliveryId: input.deliveryId, userId: input.inviteId, operationId: input.operationId.toLowerCase(), kind: INVITATION_EMAIL_KIND, recipientDigest: input.recipientDigest };
}

export function invitationEmailDeliveryId() {
  return `ied_${randomBytes(16).toString("hex")}`;
}

export function prepareInvitationEmailDelivery(cipher: Cipher, input: { deliveryId: string; inviteId: string; operationId: string; message: InvitationEmailMessage }) {
  const recipientDigest = invitationRecipientDigest(input.message.recipient);
  const encrypted = cipher.encrypt(invitationEmailBinding({ ...input, recipientDigest }), input.message);
  return { deliveryId: input.deliveryId, recipientDigest, encrypted };
}
