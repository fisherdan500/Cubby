export function isAuthorizedBrowserOperation410(httpStatus: number, payload: unknown, expectedOperationId: string) {
  if (httpStatus !== 410 || !payload || typeof payload !== "object") return false;
  const envelope = payload as { ok?: unknown; data?: unknown; status?: unknown; operationId?: unknown; code?: unknown };
  if ("ok" in envelope && envelope.ok !== true) return false;
  const data = envelope.ok === true ? envelope.data : envelope;
  if (!data || typeof data !== "object") return false;
  const terminal = data as { status?: unknown; operationId?: unknown; code?: unknown };
  return terminal.status === "expired" &&
    terminal.operationId === expectedOperationId &&
    (terminal.code === "operation_abandoned" || terminal.code === "operation_result_expired");
}
