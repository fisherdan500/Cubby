"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function DeleteActivityButton({ id, returnTo }: { id: string; returnTo?: string }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="danger"
      onClick={async () => {
        const response = await fetch(`/api/activities/${id}`, { method: "DELETE" });
        if (!response.ok) return;
        if (returnTo) {
          window.location.replace(returnTo);
        } else {
          router.refresh();
        }
      }}
    >
      Delete
    </Button>
  );
}

export function StopTimerButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        await fetch(`/api/timers/${id}/stop`, { method: "POST" });
        router.refresh();
      }}
    >
      Stop timer
    </Button>
  );
}

export function PauseTimerButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        await fetch(`/api/timers/${id}/pause`, { method: "POST" });
        router.refresh();
      }}
    >
      Pause
    </Button>
  );
}

export function ResumeTimerButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        await fetch(`/api/timers/${id}/resume`, { method: "POST" });
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
