"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { isAuthorizedBrowserOperation410 } from "@/lib/browser-operation-terminal";
import { tabScopedBrowserOperationStorageKey } from "@/lib/browser-operation-tab-scope";

const operationIdPattern = /^bmo_[0-9abcdefghjkmnpqrstvwxyz]{26}$/;
const namespacePrefix = "cubby:browser-operation-tab-namespace:";

type SavedOperation = {
  operationId: string;
  scope: "household" | "account";
  keys: string[];
};

function storedOperationId(value: string | null) {
  if (!value) return undefined;
  if (operationIdPattern.test(value)) return value;
  try {
    const parsed = JSON.parse(value) as { operationId?: unknown };
    return typeof parsed.operationId === "string" && operationIdPattern.test(parsed.operationId) ? parsed.operationId : undefined;
  } catch {
    return undefined;
  }
}

export function discoverSavedBrowserOperations(storage: Pick<Storage, "key" | "length" | "getItem">) {
  const namespaces = new Set<string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(namespacePrefix)) continue;
    const value = storage.getItem(key);
    if (value) namespaces.add(value);
  }
  const grouped = new Map<string, SavedOperation>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || ![...namespaces].some((namespace) => key.endsWith(`:tab:${namespace}`))) continue;
    const operationId = storedOperationId(storage.getItem(key));
    if (!operationId) continue;
    const scope = key.startsWith("cubby:account-appearance-operation:") ? "account" : "household";
    const identity = `${scope}:${operationId}`;
    const saved = grouped.get(identity) ?? { operationId, scope, keys: [] };
    saved.keys.push(key);
    grouped.set(identity, saved);
  }
  return [...grouped.values()].sort((left, right) => `${left.scope}:${left.operationId}`.localeCompare(`${right.scope}:${right.operationId}`));
}

export async function discoverCurrentTabSavedBrowserOperations(
  storage: Pick<Storage, "key" | "length" | "getItem">,
  resolveStorageKey = tabScopedBrowserOperationStorageKey
) {
  const partitions = new Set<string>();
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(namespacePrefix)) partitions.add(key.slice(namespacePrefix.length));
  }
  await Promise.all([...partitions].map((partition) =>
    resolveStorageKey(partition, `cubby:browser-operation-recovery-probe:${partition}`)
  ));
  return discoverSavedBrowserOperations(storage);
}

export function BrowserOperationRecovery() {
  const [saved, setSaved] = useState<SavedOperation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setSaved(await discoverCurrentTabSavedBrowserOperations(sessionStorage));
    } catch {
      setSaved([]);
    }
  }

  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (saved.length === 0 && !error) return null;

  async function abandonAll() {
    if (!window.confirm(`Discard ${saved.length} saved request${saved.length === 1 ? "" : "s"}?`)) return;
    setBusy(true);
    setError("");
    let failed = false;
    for (const operation of saved) {
      try {
        const prefix = operation.scope === "account" ? "/api/account/browser-operations" : "/api/browser-operations";
        const response = await fetch(`${prefix}/${operation.operationId}`, { method: "DELETE" });
        const body = await response.json().catch(() => null);
        if (!isAuthorizedBrowserOperation410(response.status, body, operation.operationId)) {
          failed = true;
          continue;
        }
        for (const key of operation.keys) sessionStorage.removeItem(key);
      } catch {
        failed = true;
      }
    }
    setBusy(false);
    setError(failed ? "Some saved requests could not be discarded. They remain available for reconciliation." : "");
    void refresh();
  }

  return (
    <section className="mb-3 flex min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-muted p-3" aria-label="Saved request recovery">
      {saved.length > 0 ? (
        <>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            {saved.length} saved request{saved.length === 1 ? "" : "s"} can be reconciled or explicitly discarded.
          </p>
          <Button type="button" variant="secondary" disabled={busy} onClick={() => void abandonAll()}>
            {busy ? "Discarding..." : `Discard ${saved.length} saved request${saved.length === 1 ? "" : "s"}`}
          </Button>
        </>
      ) : null}
      {error ? <p className="w-full text-sm font-semibold text-danger" role="alert">{error}</p> : null}
    </section>
  );
}
