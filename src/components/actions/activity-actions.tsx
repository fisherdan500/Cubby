"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function DeleteActivityButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Button
      type="button"
      variant="danger"
      onClick={async () => {
        await fetch(`/api/activities/${id}`, { method: "DELETE" });
        router.refresh();
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
