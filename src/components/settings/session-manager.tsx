"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";

type SessionRow = {
  token: string;
  expiresAt: string | Date;
  userAgent?: string | null;
  ipAddress?: string | null;
};

export function SessionManager() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [pinMessage, setPinMessage] = useState("");

  async function load() {
    const result = await authClient.listSessions();
    setSessions((result.data ?? []).map((session) => ({ ...session, expiresAt: session.expiresAt })) as SessionRow[]);
  }

  useEffect(() => {
    void load();
  }, []);

  async function savePin(formData: FormData) {
    setPinMessage("");
    const response = await fetch("/api/trusted-devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(formData))
    });
    const result = await response.json();
    setPinMessage(result.ok ? "PIN saved for this trusted device." : result.error.message);
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Active sessions</h2>
        {sessions.length === 0 ? <p className="text-sm text-muted-foreground">No sessions loaded.</p> : null}
        {sessions.map((session) => (
          <div key={session.token} className="rounded-lg border border-border bg-card p-3">
            <p className="text-sm font-semibold">{session.userAgent || "Unknown device"}</p>
            <p className="text-xs text-muted-foreground">
              {session.ipAddress || "No IP"} - expires {new Date(session.expiresAt).toLocaleDateString()}
            </p>
            <Button
              className="mt-3"
              variant="secondary"
              onClick={async () => {
                await authClient.revokeSession({ token: session.token });
                await load();
              }}
            >
              Revoke
            </Button>
          </div>
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Trusted-device PIN</h2>
        <form action={savePin} className="space-y-3">
          <Input name="label" placeholder="Device label" defaultValue="My phone" />
          <Input name="pin" inputMode="numeric" pattern="[0-9]*" placeholder="4 to 8 digit PIN" required />
          <Button>Save PIN</Button>
        </form>
        {pinMessage ? <p className="text-sm text-muted-foreground">{pinMessage}</p> : null}
      </section>
    </div>
  );
}
