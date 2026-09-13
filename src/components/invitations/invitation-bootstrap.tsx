"use client";

import { useEffect, useRef, useState } from "react";
import { consumeInvitationFragment } from "@/lib/invitation-token-cutover";
import { invitationBrowserPartitionDigest } from "@/components/invitations/invitation-browser";

type BootstrapState = "idle" | "claiming" | "claimed" | "unavailable";

export function InvitationBootstrap() {
  const [state, setState] = useState<BootstrapState>("idle");
  const generation = useRef(0);

  useEffect(() => {
    const fragment = consumeInvitationFragment(location.href);
    if (!fragment) return;
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    // The browser address is clean before the only permitted token-bearing request starts.
    history.replaceState(null, "", fragment.replacementUrl);
    setState("claiming");
    void (async () => {
      try {
        const browserPartitionDigest = await invitationBrowserPartitionDigest();
        const response = await fetch("/api/invitations/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: fragment.rawToken, browserPartitionDigest }),
          cache: "no-store",
          signal: controller.signal
        });
        const body = await response.json().catch(() => null) as { ok?: boolean; data?: { status?: string } } | null;
        if (controller.signal.aborted || generation.current !== requestGeneration) return;
        const claimed = response.ok && body?.ok && body.data?.status === "claimed";
        setState(claimed ? "claimed" : "unavailable");
        window.dispatchEvent(new CustomEvent("cubby:invitation-claim-complete", { detail: { claimed } }));
      } catch {
        if (!controller.signal.aborted && generation.current === requestGeneration) setState("unavailable");
      }
    })();
    return () => { controller.abort(); };
  }, []);

  if (state === "idle") return null;
  return <p className="text-sm text-muted-foreground" aria-live="polite">{state === "claiming" ? "Preparing your invitation…" : state === "claimed" ? "Invitation ready. Continue below." : "This invitation is unavailable."}</p>;
}
