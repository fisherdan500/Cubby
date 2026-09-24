import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

type Environment = Partial<Pick<NodeJS.ProcessEnv, "SMTP_HOST" | "SMTP_PORT" | "SMTP_USER" | "SMTP_PASSWORD" | "EMAIL_FROM" | "SMTP_CA_CERT" | "SMTP_SECURE">>;
type Factory = { createTransport: typeof nodemailer.createTransport };
/** Only for an interactive caller, such as the owner's test send; the background worker keeps nodemailer's defaults. */
type Timeouts = { connectionTimeout: number; greetingTimeout: number; socketTimeout: number };

export function createSmtpEmailDeliveryAdapter(environment: Environment = { SMTP_HOST: process.env.SMTP_HOST, SMTP_PORT: process.env.SMTP_PORT, SMTP_USER: process.env.SMTP_USER, SMTP_PASSWORD: process.env.SMTP_PASSWORD, EMAIL_FROM: process.env.EMAIL_FROM, SMTP_CA_CERT: process.env.SMTP_CA_CERT, SMTP_SECURE: process.env.SMTP_SECURE }, factory: Factory = nodemailer, timeouts?: Timeouts) {
  const port = Number(environment.SMTP_PORT);
  if (!environment.SMTP_HOST || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !environment.EMAIL_FROM || !environment.SMTP_USER || !environment.SMTP_PASSWORD || (environment.SMTP_SECURE !== undefined && !["true", "false"].includes(environment.SMTP_SECURE))) throw new Error("email_delivery_smtp_unavailable");
  const auth = { user: environment.SMTP_USER, pass: environment.SMTP_PASSWORD };
  const secure = environment.SMTP_SECURE === "true" || (environment.SMTP_SECURE === undefined && port === 465);
  const transport = factory.createTransport({ host: environment.SMTP_HOST, port, secure, requireTLS: !secure, tls: { rejectUnauthorized: true, ...(environment.SMTP_CA_CERT ? { ca: environment.SMTP_CA_CERT } : {}) }, auth, ...(timeouts ?? {}) }) as Transporter;
  return {
    async send(payload: { recipient: string; subject: string; text: string; messageId: string }) {
      const info = await transport.sendMail({ from: environment.EMAIL_FROM, to: payload.recipient, subject: payload.subject, text: payload.text, messageId: payload.messageId });
      const responseCode = Number(String(info.response ?? "").match(/^(\d{3})\b/)?.[1]);
      const accepted = (info.accepted ?? []).map(String);
      if (info.rejected?.length || accepted.length !== 1 || accepted[0] !== payload.recipient) throw new Error("recipient_rejected");
      if (responseCode >= 400 && responseCode < 500) throw new Error("smtp_temporary");
      if (responseCode !== 250) throw new Error("smtp_rejected");
      return { responseCode, messageId: String(info.messageId), accepted };
    }
  };
}
