"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export default function InvitationDispatchPage() {
  const [state, setState] = useState("Continuing your invitation…");
  const [stalled, setStalled] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); const requestGeneration = ++generation.current;
    void (async () => {
      let status: unknown = null;
      let reached = false;
      try {
        const response = await fetch("/api/invitations/post-signin-bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}), cache: "no-store", signal: controller.signal });
        const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { status?: unknown } } | null;
        reached = true;
        if (response.ok && payload?.ok) status = payload.data?.status;
      } catch {
        setState("We could not confirm an invitation. Continuing to Cubby…");
      }
      if (controller.signal.aborted || generation.current !== requestGeneration) return;
      if (status === "review") { window.location.replace("/invite"); return; }
      // Simplified signup: an invited user who signs in WITHOUT re-opening their invitation link has
      // no claim cookie (it is sameSite=strict and set only by the claim route), so binding reports
      // unavailable. Redirecting silently to "/" strands them with no explanation and no way back,
      // because an unaccepted invitation account cannot use the app yet. Hold the page and tell them
      // what to do instead.
      if (reached) { setStalled(true); setState("We could not match an invitation to this account."); return; }
      window.location.replace("/");
    })();
    return () => controller.abort();
  }, []);
  return <main className="flex min-h-screen items-center justify-center px-4">
    <div className="max-w-md space-y-3 text-center">
      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{state}</p>
      {stalled ? <>
        <p className="text-sm text-muted-foreground">If you were invited, open the invitation link from your email again in this browser to finish joining. The link is what confirms which invitation belongs to you.</p>
        <Link href="/" className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-primary underline-offset-4 hover:underline">Continue to Cubby</Link>
      </> : null}
    </div>
  </main>;
}
