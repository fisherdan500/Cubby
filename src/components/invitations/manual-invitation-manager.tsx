"use client";

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { invitationFingerprint, invitationOperationId } from "@/components/invitations/invitation-browser";
import { formatInstantDate } from "@/lib/timezone";

type Invite = { id: string; email: string; role: "admin" | "parent" | "caretaker" | "read_only"; expiresAt: string };
type Retained = { operationId: string; openingFingerprint: string; intentFingerprint?: string; inviteId?: string; acknowledgement?: string; kind: "create" | "replace" | "revoke" | "revoke-all" };
const retainedKey = "cubby:invitation-manual-operation:v1";
const genericFailure = "We could not confirm that request. Check its status before trying again.";

function readRetained(): Retained | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(retainedKey) ?? "null") as Retained | null;
    return parsed && typeof parsed.operationId === "string" && typeof parsed.openingFingerprint === "string" && (["create", "replace", "revoke", "revoke-all"] as string[]).includes(parsed.kind) ? parsed : null;
  } catch { return null; }
}
function retain(value: Retained | null) { try { if (value) sessionStorage.setItem(retainedKey, JSON.stringify(value)); else sessionStorage.removeItem(retainedKey); } catch { /* Server status remains authoritative. */ } }
function data(value: unknown) { const body = value as { ok?: boolean; data?: Record<string, unknown> } | null; return body?.ok && body.data ? body.data : null; }

export function ManualInvitationManager({ invites, canInviteAdmin, isOwner, timeZone }: { invites: Invite[]; canInviteAdmin: boolean; isOwner: boolean; timeZone: string }) {
  const [message, setMessage] = useState("");
  const [displayOnceUrl, setDisplayOnceUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [retained, setRetained] = useState<Retained | null>(null);
  const generation = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const returnFocus = useRef<HTMLElement | null>(null);
  const displayOnceRegion = useRef<HTMLDivElement>(null);
  const errorSummary = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    setRetained(readRetained());
    const activeControllers = controllers.current;
    return () => { for (const controller of activeControllers) controller.abort(); activeControllers.clear(); };
  }, []);
  useEffect(() => { if (displayOnceUrl) displayOnceRegion.current?.focus(); }, [displayOnceUrl]);
  useEffect(() => { if (message && !message.startsWith("Copy the invitation")) errorSummary.current?.focus(); }, [message]);
  async function request(path: string, payload: Record<string, unknown>) {
    const controller = new AbortController(); controllers.current.add(controller); const requestGeneration = ++generation.current;
    try {
      const response = await fetch(path, { method: "POST", cache: "no-store", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const result = data(await response.json().catch(() => null));
      return !controller.signal.aborted && generation.current === requestGeneration ? result : null;
    } finally { controllers.current.delete(controller); }
  }
  function saveRetained(next: Retained | null) { retain(next); setRetained(next); }
  function showDisplayOnce(result: Record<string, unknown>) {
    const path = typeof result.displayOnceUrl === "string" ? result.displayOnceUrl : typeof result.acceptUrl === "string" ? result.acceptUrl : typeof result.inviteToken === "string" ? `/invite#c=${encodeURIComponent(result.inviteToken)}` : "";
    if (!path) { setMessage("The invitation was completed. Its link is not available again; create a replacement only if needed."); return; }
    setDisplayOnceUrl(path.startsWith("http") ? path : `${window.location.origin}${path}`);
    setMessage("Copy the invitation link now. It will not be shown again after this response.");
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const recipientEmail = String(form.get("recipientEmail") ?? "").trim(); const role = String(form.get("role") ?? "caretaker"); const expiresInHours = Number(form.get("expiresInHours") ?? 168);
    if (!recipientEmail || !Number.isInteger(expiresInHours)) return;
    setBusy(true); setMessage(""); setDisplayOnceUrl("");
    try {
      const operationId = retained?.kind === "create" ? retained.operationId : invitationOperationId(); const openingFingerprint = await invitationFingerprint("manual-create", { operationId, recipientEmail, role, expiresInHours });
      if (retained?.kind === "create" && retained.openingFingerprint !== openingFingerprint) { setMessage("This differs from the retained invitation request. Check its status before starting a new request."); return; }
      const next = { operationId, openingFingerprint, kind: "create" as const }; saveRetained(next);
      const reserve = await request("/api/invitations/manual/create", { action: "reserve", operationId, recipientEmail, role, expiresInHours, openingFingerprint });
      if (reserve?.status !== "prepared") throw new Error("reserve");
      const intentFingerprint = await invitationFingerprint("manual-create-submit", { operationId, recipientEmail, role, expiresInHours });
      const submit = await request("/api/invitations/manual/create", { action: "submit", operationId, openingFingerprint, intentFingerprint });
      if (submit?.status !== "completed" && submit?.status !== "created") throw new Error("submit");
      saveRetained(null); showDisplayOnce(submit); event.currentTarget.reset();
    } catch { setMessage(genericFailure); } finally { setBusy(false); returnFocus.current?.focus(); }
  }
  async function replace(inviteId: string, event: MouseEvent<HTMLButtonElement>) {
    returnFocus.current = event.currentTarget; setBusy(true); setMessage(""); setDisplayOnceUrl("");
    try {
      const operationId = retained?.kind === "replace" ? retained.operationId : invitationOperationId(); const expiresInHours = 168; const openingFingerprint = await invitationFingerprint("manual-replace", { operationId, inviteId, expiresInHours });
      if (retained?.kind === "replace" && retained.openingFingerprint !== openingFingerprint) { setMessage("This differs from the retained replacement request. Check its status before starting a new request."); return; }
      const next = { operationId, openingFingerprint, kind: "replace" as const }; saveRetained(next);
      const reserve = await request("/api/invitations/manual/replace", { action: "reserve", operationId, inviteId, expiresInHours, openingFingerprint });
      if (reserve?.status !== "prepared") throw new Error("reserve");
      const intentFingerprint = await invitationFingerprint("manual-replace-submit", { operationId, inviteId, expiresInHours });
      const submit = await request("/api/invitations/manual/replace", { action: "submit", operationId, openingFingerprint, intentFingerprint });
      if (submit?.status !== "completed" && submit?.status !== "replaced") throw new Error("submit");
      saveRetained(null); showDisplayOnce(submit);
    } catch { setMessage(genericFailure); } finally { setBusy(false); returnFocus.current?.focus(); }
  }
  async function status() {
    if (!retained) return; setBusy(true); setMessage("");
    try {
      const endpoint = retained.kind === "create" ? "/api/invitations/manual/status" : retained.kind === "replace" ? "/api/invitations/manual/replace/status" : retained.kind === "revoke" ? "/api/invitations/revoke" : "/api/invitations/revoke-all";
      const result = await request(endpoint, retained.kind === "revoke" ? { ...retained, inviteId: retained.inviteId } : retained);
      if (!result) throw new Error("status");
      if (result.status === "completed" || result.status === "created" || result.status === "replaced" || result.status === "revoked") { saveRetained(null); setMessage(retained.kind === "revoke" || retained.kind === "revoke-all" ? "The revocation completed." : "The request completed. A display-once link is not available from status; create a replacement only if needed."); }
      else if (result.status === "prepared") setMessage("This request is still prepared. You can abandon it or retry from the same form.");
      else setMessage("This request is no longer available.");
    } catch { setMessage(genericFailure); } finally { setBusy(false); }
  }
  async function abandon() {
    if (!retained) return; setBusy(true); setMessage("");
    try {
      if (retained.kind === "revoke" || retained.kind === "revoke-all") { saveRetained(null); setMessage("The retained revocation request was cleared locally. Its server status is unchanged."); return; }
      const endpoint = retained.kind === "create" ? "/api/invitations/manual/abandon" : "/api/invitations/manual/replace/abandon";
      const result = await request(endpoint, retained); if (!result || (result.status !== "abandoned" && result.state !== "abandoned")) throw new Error("abandon");
      saveRetained(null); setMessage("The prepared invitation request was abandoned.");
    } catch { setMessage(genericFailure); } finally { setBusy(false); }
  }
  async function revoke(inviteId: string, event: MouseEvent<HTMLButtonElement>) {
    returnFocus.current = event.currentTarget; setBusy(true); setMessage("");
    try {
      const operationId = retained?.kind === "revoke" ? retained.operationId : invitationOperationId(); const openingFingerprint = await invitationFingerprint("invite-revoke", { operationId, inviteId }); const intentFingerprint = await invitationFingerprint("invite-revoke-submit", { operationId, inviteId });
      if (retained?.kind === "revoke" && (retained.openingFingerprint !== openingFingerprint || retained.intentFingerprint !== intentFingerprint || retained.inviteId !== inviteId)) { setMessage("This differs from the retained revocation request. Check its status before starting a new request."); return; }
      saveRetained({ operationId, openingFingerprint, intentFingerprint, inviteId, kind: "revoke" });
      const result = await request("/api/invitations/revoke", { inviteId, operationId, openingFingerprint, intentFingerprint });
      if (result?.status !== "revoked") throw new Error("revoke"); saveRetained(null); setMessage("Invitation revoked.");
    } catch { setMessage(genericFailure); } finally { setBusy(false); }
  }
  async function revokeAll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const acknowledgement = String(new FormData(event.currentTarget).get("acknowledgement") ?? "");
    if (acknowledgement !== "I_REVOKE_ALL_PENDING_INVITATIONS") { setMessage("Type the acknowledgement exactly before revoking all invitations."); return; }
    setBusy(true); setMessage("");
    try {
      const operationId = retained?.kind === "revoke-all" ? retained.operationId : invitationOperationId(); const openingFingerprint = await invitationFingerprint("invite-revoke-all", { operationId }); const intentFingerprint = await invitationFingerprint("invite-revoke-all-submit", { operationId, acknowledgement });
      if (retained?.kind === "revoke-all" && (retained.openingFingerprint !== openingFingerprint || retained.intentFingerprint !== intentFingerprint || retained.acknowledgement !== acknowledgement)) { setMessage("This differs from the retained revocation request. Check its status before starting a new request."); return; }
      saveRetained({ operationId, openingFingerprint, intentFingerprint, acknowledgement, kind: "revoke-all" });
      const result = await request("/api/invitations/revoke-all", { operationId, acknowledgement, openingFingerprint, intentFingerprint });
      if (result?.status !== "revoked") throw new Error("revoke-all"); saveRetained(null); setMessage("Pending invitations revoked.");
    } catch { setMessage(genericFailure); } finally { setBusy(false); }
  }
  return <section aria-labelledby="manual-invites-heading" className="space-y-4"><div><h2 id="manual-invites-heading" className="text-lg font-bold">Invite member</h2><p className="text-sm text-muted-foreground">Create a household invitation. The link is displayed once, only after completion.</p></div>
    <form onSubmit={(event) => void create(event)} className="space-y-3"><label className="block text-sm font-semibold">Recipient email<Input name="recipientEmail" type="email" autoComplete="email" required /></label><label className="block text-sm font-semibold">Access level<select name="role" defaultValue="caretaker" className="mt-1 min-h-11 w-full rounded-lg border border-control bg-card px-3 py-2 text-sm"><option value="caretaker">Caretaker</option><option value="parent">Parent</option><option value="read_only">Read only</option>{canInviteAdmin ? <option value="admin">Admin</option> : null}</select></label><label className="block text-sm font-semibold">Expires in<select name="expiresInHours" defaultValue="168" className="mt-1 min-h-11 w-full rounded-lg border border-control bg-card px-3 py-2 text-sm"><option value="1">1 hour</option><option value="24">1 day</option><option value="168">7 days</option></select></label><Button type="submit" disabled={busy}>{busy ? "Working…" : "Create invitation"}</Button></form>
    {retained ? <div className="flex flex-wrap gap-2 rounded-lg border border-border p-3"><p className="w-full text-sm text-muted-foreground">A prepared invitation request is available for this browser tab.</p><Button type="button" variant="secondary" onClick={() => void status()} disabled={busy}>Check request status</Button><Button type="button" variant="ghost" onClick={() => void abandon()} disabled={busy}>Abandon request</Button></div> : null}
    {displayOnceUrl ? <div ref={displayOnceRegion} role="region" aria-label="Display-once invitation link" aria-live="off" tabIndex={-1} className="rounded-lg border border-border bg-muted p-3"><p className="font-semibold">Copy invitation link now</p><p className="mt-1 break-all text-sm text-muted-foreground">{displayOnceUrl}</p><Button type="button" variant="secondary" className="mt-3" onClick={() => void navigator.clipboard?.writeText(displayOnceUrl)}>Copy invitation link</Button><p className="mt-2 text-xs text-muted-foreground">This link is not retained in status or after remounting this screen.</p></div> : null}
    <div className="space-y-2 border-t border-border pt-4"><h3 className="font-bold">Pending invitations</h3>{invites.length === 0 ? <p className="text-sm text-muted-foreground">No pending invitations.</p> : invites.map((invite) => <div key={invite.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"><div className="min-w-0"><p className="truncate font-semibold">{invite.email}</p><p className="text-sm text-muted-foreground">{invite.role} · expires {formatInstantDate(invite.expiresAt, timeZone)}</p></div><div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={(event) => void replace(invite.id, event)} disabled={busy}>Replace link</Button><Button type="button" variant="danger" onClick={(event) => void revoke(invite.id, event)} disabled={busy}>Revoke</Button></div></div>)}</div>
    {isOwner && invites.length > 0 ? <form onSubmit={(event) => void revokeAll(event)} className="space-y-3 rounded-lg border border-danger/40 bg-danger/5 p-3"><h3 className="font-bold text-danger">Revoke every pending invitation</h3><label className="block text-sm font-semibold">Type <span className="font-mono">I_REVOKE_ALL_PENDING_INVITATIONS</span><Input name="acknowledgement" autoComplete="off" required /></label><Button type="submit" variant="danger" disabled={busy}>Revoke all pending invitations</Button></form> : null}
    {message ? <p ref={errorSummary} role="alert" tabIndex={-1} className="text-sm text-muted-foreground">{message}</p> : null}
  </section>;
}
