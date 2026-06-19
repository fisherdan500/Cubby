"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function AcceptInviteButton({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  return (
    <div className="space-y-3">
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button
        onClick={async () => {
          const response = await fetch(`/api/invites/${token}/accept`, { method: "POST" });
          const result = await response.json();
          if (!result.ok) {
            setError(result.error.message);
            return;
          }
          router.push("/app");
          router.refresh();
        }}
      >
        Accept invite
      </Button>
    </div>
  );
}
