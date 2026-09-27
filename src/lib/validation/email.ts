import { z } from "zod";

const mailbox = z.string().email().max(254);

/** A single bare mailbox, never an address list, display name or mail header. */
export function singleMailbox(value: string): string {
  // Reject controls before trimming: a newline must not become a valid address.
  if (typeof value !== "string" || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error("recipient_rejected");
  const parsed = mailbox.safeParse(value.trim());
  if (!parsed.success) throw new Error("recipient_rejected");
  return parsed.data;
}
