"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

function browserOperationId() {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  return `bmo_${Array.from(bytes, (byte) => alphabet[byte & 31]).join("")}`;
}

function TimerButton({ id, operation, label }: { id: string; operation: "stop" | "pause" | "resume"; label: string }) {
  const router = useRouter();
  const operationId = useRef<string>();
  return <Button type="button" variant="secondary" onClick={async () => {
    operationId.current ??= browserOperationId();
    const response = await fetch(`/api/timers/${id}/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: operationId.current }) });
    const result = await response.json().catch(() => null) as { data?: { status?: string } } | null;
    if (!response.ok || result?.data?.status === "pending") return;
    operationId.current = undefined;
    router.refresh();
  }}>{label}</Button>;
}

export function StopTimerButton({ id }: { id: string }) { return <TimerButton id={id} operation="stop" label="Stop timer" />; }
export function PauseTimerButton({ id }: { id: string }) { return <TimerButton id={id} operation="pause" label="Pause" />; }
export function ResumeTimerButton({ id }: { id: string }) { return <TimerButton id={id} operation="resume" label="Resume" />; }

export function UndoLastButton() {
  const router = useRouter();
  const operationId = useRef<string>();
  return <Button type="button" variant="secondary" onClick={async () => {
    operationId.current ??= browserOperationId();
    const response = await fetch("/api/activities/undo-last", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: operationId.current }) });
    const result = await response.json().catch(() => null) as { data?: { status?: string } } | null;
    if (!response.ok || result?.data?.status === "pending") return;
    operationId.current = undefined;
    router.refresh();
  }}>Undo last</Button>;
}
