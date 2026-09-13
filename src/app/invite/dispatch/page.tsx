"use client";

import { useEffect, useRef, useState } from "react";

export default function InvitationDispatchPage() {
  const [state, setState] = useState("Continuing your invitation…");
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); const requestGeneration = ++generation.current;
    void (async () => {
      let status: unknown = null;
      try {
        const response = await fetch("/api/invitations/post-signin-bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}), cache: "no-store", signal: controller.signal });
        const payload = await response.json().catch(() => null) as { ok?: boolean; data?: { status?: unknown } } | null;
        if (response.ok && payload?.ok) status = payload.data?.status;
      } catch {
        setState("We could not confirm an invitation. Continuing to Cubby…");
      }
      if (!controller.signal.aborted && generation.current === requestGeneration) window.location.replace(status === "review" ? "/invite" : "/");
    })();
    return () => controller.abort();
  }, []);
  return <main className="flex min-h-screen items-center justify-center px-4"><p role="status" aria-live="polite" className="text-sm text-muted-foreground">{state}</p></main>;
}
