import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { singleMailbox } from "@/lib/validation/email";

type Environment = Partial<Pick<NodeJS.ProcessEnv, "SMTP_HOST" | "SMTP_PORT" | "SMTP_USER" | "SMTP_PASSWORD" | "EMAIL_FROM" | "SMTP_CA_CERT" | "SMTP_SECURE">>;
type Factory = { createTransport: typeof nodemailer.createTransport };
/** Only for an interactive caller, such as the owner's test send; the background worker keeps nodemailer's defaults. */
type Timeouts = { connectionTimeout: number; greetingTimeout: number; socketTimeout: number };

function smtpResponseCode(error: unknown): number | null {
  const code = error && typeof error === "object" ? (error as { responseCode?: unknown }).responseCode : null;
  return typeof code === "number" && Number.isInteger(code) && code >= 100 && code < 600 ? code : null;
}

function smtpFailureCode(error: unknown) {
  const failure = error && typeof error === "object" ? error as { code?: unknown; responseCode?: unknown; command?: unknown } : {};
  const responseCode = smtpResponseCode(error) ?? 0;
  // A temporary SMTP reply takes precedence even when Nodemailer calls it an auth/envelope error.
  if (responseCode >= 400 && responseCode < 500) return "smtp_temporary";
  if (failure.code === "EAUTH") return "smtp_auth";
  if (failure.code === "EENVELOPE" && failure.command !== "MAIL FROM") return "recipient_rejected";
  if (responseCode >= 500 && responseCode < 600 || failure.code === "EENVELOPE" || failure.code === "EMESSAGE") return "smtp_rejected";
  if (failure.code === "ETIMEDOUT") return "smtp_timeout";
  return "smtp_connection";
}

export function smtpEmailDeliveryConfigured(environment: Environment) {
  const port = Number(environment.SMTP_PORT);
  return Boolean(environment.SMTP_HOST && Number.isSafeInteger(port) && port >= 1 && port <= 65535 && environment.EMAIL_FROM && environment.SMTP_USER && environment.SMTP_PASSWORD && (environment.SMTP_SECURE === undefined || ["true", "false"].includes(environment.SMTP_SECURE)));
}

export function createSmtpEmailDeliveryAdapter(environment: Environment = { SMTP_HOST: process.env.SMTP_HOST, SMTP_PORT: process.env.SMTP_PORT, SMTP_USER: process.env.SMTP_USER, SMTP_PASSWORD: process.env.SMTP_PASSWORD, EMAIL_FROM: process.env.EMAIL_FROM, SMTP_CA_CERT: process.env.SMTP_CA_CERT, SMTP_SECURE: process.env.SMTP_SECURE }, factory: Factory = nodemailer, timeouts?: Timeouts) {
  const port = Number(environment.SMTP_PORT);
  if (!smtpEmailDeliveryConfigured(environment)) throw new Error("email_delivery_smtp_unavailable");
  const auth = { user: environment.SMTP_USER, pass: environment.SMTP_PASSWORD };
  const secure = environment.SMTP_SECURE === "true" || (environment.SMTP_SECURE === undefined && port === 465);
  const transport = factory.createTransport({ host: environment.SMTP_HOST, port, secure, requireTLS: !secure, tls: { rejectUnauthorized: true, ...(environment.SMTP_CA_CERT ? { ca: environment.SMTP_CA_CERT } : {}) }, auth, ...(timeouts ?? {}) }) as Transporter;
  return {
    async send(payload: { recipient: string; subject: string; text: string; messageId: string }) {
      const recipient = singleMailbox(payload.recipient);
      if (recipient !== payload.recipient) throw new Error("recipient_rejected");
      const info = await transport.sendMail({ from: environment.EMAIL_FROM, to: { name: "", address: recipient }, envelope: { from: environment.EMAIL_FROM!, to: [recipient] }, subject: payload.subject, text: payload.text, messageId: payload.messageId }).catch((error: unknown) => {
        // Preserve only the bounded numeric reply for the owner's diagnostic, never provider text.
        throw Object.assign(new Error(smtpFailureCode(error)), { responseCode: smtpResponseCode(error) });
      });
      const responseCode = Number(String(info.response ?? "").match(/^(\d{3})\b/)?.[1]);
      const accepted = (info.accepted ?? []).map(String);
      if (info.rejected?.length || accepted.length !== 1 || accepted[0] !== payload.recipient) throw new Error("recipient_rejected");
      if (responseCode >= 400 && responseCode < 500) throw new Error("smtp_temporary");
      if (responseCode !== 250) throw new Error("smtp_rejected");
      return { responseCode, messageId: String(info.messageId), accepted };
    }
  };
}
