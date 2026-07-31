"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function StopTimerButton({ id }: { id: string }) {
  const router = useRouter();
  const mutationId = useRef<string>();
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        mutationId.current ??= crypto.randomUUID();
        const response = await fetch(`/api/timers/${id}/stop`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientMutationId: mutationId.current })
        });
        if (!response.ok) return;
        mutationId.current = undefined;
        router.refresh();
      }}
    >
      Stop timer
    </Button>
  );
}

export function PauseTimerButton({ id }: { id: string }) {
  const router = useRouter();
  const mutationId = useRef<string>();
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        mutationId.current ??= crypto.randomUUID();
        const response = await fetch(`/api/timers/${id}/pause`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientMutationId: mutationId.current })
        });
        if (!response.ok) return;
        mutationId.current = undefined;
        router.refresh();
      }}
    >
      Pause
    </Button>
  );
}

export function ResumeTimerButton({ id }: { id: string }) {
  const router = useRouter();
  const mutationId = useRef<string>();
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        mutationId.current ??= crypto.randomUUID();
        const response = await fetch(`/api/timers/${id}/resume`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientMutationId: mutationId.current })
        });
        if (!response.ok) return;
        mutationId.current = undefined;
        router.refresh();
      }}
    >
      Resume
    </Button>
  );
}

export function UndoLastButton() {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        await fetch("/api/activities/undo-last", { method: "POST" });
        router.refresh();
      }}
    >
      Undo last
    </Button>
  );
}
