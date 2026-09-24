"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Result =
  | { status: "sent"; recipient: string }
  | { status: "not_configured" }
  | { status: "failed"; reason: "authentication" | "connection" | "temporary" | "rejected" | "unknown"; responseCode: number | null; recipient: string };

/** What the owner can do about each outcome, in the terms of the .env file they will be editing. */
export function testEmailMessage(result: Result) {
  const code = result.status === "failed" && result.responseCode ? ` (server reply ${result.responseCode})` : "";
  if (result.status === "sent") {
    return `Sent a test email to ${result.recipient}. If it hasn't arrived in a few minutes, check the spam folder, and check that EMAIL_FROM is an address your mail account is allowed to send from.`;
  }
  if (result.status === "not_configured") {
    return "Email isn't set up. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and EMAIL_FROM in .env, then run docker compose up -d.";
  }
  switch (result.reason) {
    case "authentication":
      return `The mail server rejected the login${code}. Check SMTP_USER and SMTP_PASSWORD; many providers require an app password rather than your account password.`;
    case "connection":
      return "Couldn't reach the mail server. Check SMTP_HOST and SMTP_PORT (587 for STARTTLS, 465 for TLS), and that this server can reach it.";
    case "temporary":
      return `The mail server deferred the message${code}. Try again in a few minutes.`;
    case "rejected":
      return `The mail server refused the message${code}. Usually EMAIL_FROM is not an address your mail account may send from.`;
    default:
      return "Sending failed for a reason Cubby doesn't recognize. Your mail provider's activity log will have the details.";
  }
}

export function PlatformTestEmail() {
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);

  async function send() {
    setSending(true);
    setMessage("");
    try {
      const response = await fetch("/api/platform/test-email", { method: "POST" });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; data?: Result; error?: { message?: string } } | null;
      if (!response.ok || !body?.ok || !body.data) {
        setSent(false);
        setMessage(body?.error?.message ?? "Couldn't send the test email. Try again.");
        return;
      }
      setSent(body.data.status === "sent");
      setMessage(testEmailMessage(body.data));
    } catch {
      setSent(false);
      setMessage("Couldn't reach Cubby. Try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="platform-test-email-heading">
      <div>
        <h2 id="platform-test-email-heading" className="text-lg font-semibold">Email delivery</h2>
        <p className="text-sm text-muted-foreground">
          Send a test message to your own address to check the mail settings in .env.
        </p>
      </div>
      <Button type="button" variant="secondary" onClick={() => void send()} disabled={sending}>
        {sending ? "Sending..." : "Send test email"}
      </Button>
      {message ? (
        <p role="status" className={sent ? "rounded-lg bg-muted p-3 text-sm" : "rounded-lg bg-danger/10 p-3 text-sm text-danger"}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
