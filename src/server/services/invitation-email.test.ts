import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEmailDeliveryCipher } from "@/server/services/email-change-delivery";
import {
  composeInvitationEmail,
  invitationEmailAvailable,
  invitationEmailBinding,
  invitationEmailLink,
  invitationRecipientDigest,
  prepareInvitationEmailDelivery
} from "@/server/services/invitation-email";

const smtp = { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "587", SMTP_USER: "user", SMTP_PASSWORD: "[REDACTED]", EMAIL_FROM: "Cubby <noreply@example.invalid>" };
const keyring = { CUBBY_EMAIL_DELIVERY_KEYRING: "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" };

describe("invitation email availability", () => {
  it("is available only with complete SMTP settings and a valid delivery keyring", () => {
    expect(invitationEmailAvailable({ ...smtp, ...keyring })).toBe(true);
    expect(invitationEmailAvailable({ ...keyring })).toBe(false);
    expect(invitationEmailAvailable({ ...smtp, SMTP_PORT: "not-a-port", ...keyring })).toBe(false);
    expect(invitationEmailAvailable({ ...smtp })).toBe(false);
    expect(invitationEmailAvailable({ ...smtp, CUBBY_EMAIL_DELIVERY_KEYRING: "1:bad", CUBBY_EMAIL_DELIVERY_ACTIVE_KEY_VERSION: "1" })).toBe(false);
  });
});

describe("invitation email content", () => {
  it("links to the invitation fragment on the configured Cubby address", () => {
    expect(invitationEmailLink("https://cubby.home.arpa/", "a-b_c")).toBe("https://cubby.home.arpa/invite#c=a-b_c");
    expect(invitationEmailLink("https://cubby.home.arpa/some/path", "tok")).toBe("https://cubby.home.arpa/invite#c=tok");
  });

  it("writes a plain-text invitation naming the household, inviter and expiry, with an ignore note", () => {
    const message = composeInvitationEmail({ recipient: "member@example.test", householdName: "The Fishers", inviterName: "Dana", link: "https://cubby.test/invite#c=tok", expiresAt: new Date("2030-01-08T12:00:00.000Z"), timeZone: "UTC" });
    expect(message.recipient).toBe("member@example.test");
    expect(message.subject).toBe("Dana invited you to The Fishers on Cubby");
    expect(message.text).toContain("Dana invited you to join The Fishers on Cubby.");
    expect(message.text).toContain("https://cubby.test/invite#c=tok");
    expect(message.text).toMatch(/expires .*2030/);
    expect(message.text).toContain("If you were not expecting this invitation, you can ignore this email.");
  });

  it("keeps header-breaking characters out of the subject", () => {
    const message = composeInvitationEmail({ recipient: "member@example.test", householdName: "Home\r\nBcc: x@example.test", inviterName: "Dana\n", link: "https://cubby.test/invite#c=tok", expiresAt: new Date("2030-01-08T12:00:00.000Z"), timeZone: "UTC" });
    expect(message.subject).not.toMatch(/[\r\n]/);
  });
});

describe("invitation email delivery payload", () => {
  it("digests the normalized recipient exactly as the database does", () => {
    expect(invitationRecipientDigest(" Member@Example.TEST ")).toEqual(createHash("sha256").update("member@example.test", "utf8").digest());
  });

  it("encrypts the message under a binding tied to this delivery, invitation and operation, never exposing the link", () => {
    const cipher = createEmailDeliveryCipher(keyring);
    const message = { recipient: "member@example.test", subject: "Subject", text: "https://cubby.test/invite#c=display-once-token" };
    const prepared = prepareInvitationEmailDelivery(cipher, { deliveryId: "ied_1", inviteId: "inv_1", operationId: "11111111-1111-4111-8111-111111111111", message });
    expect(prepared.recipientDigest).toEqual(invitationRecipientDigest("member@example.test"));
    expect(JSON.stringify(prepared)).not.toContain("display-once-token");
    const binding = invitationEmailBinding({ deliveryId: "ied_1", inviteId: "inv_1", operationId: "11111111-1111-4111-8111-111111111111", recipientDigest: prepared.recipientDigest });
    expect(binding.kind).toBe("household_invitation");
    expect(cipher.decrypt(binding, prepared.encrypted)).toEqual(message);
    expect(() => cipher.decrypt({ ...binding, userId: "inv_2" }, prepared.encrypted)).toThrow("email_delivery_cipher_invalid");
  });
});
