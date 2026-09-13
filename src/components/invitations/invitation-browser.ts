export async function invitationDigest(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function invitationBrowserPartitionDigest() {
  const key = "cubby:invitation-browser-partition:v1";
  let partition = sessionStorage.getItem(key);
  if (!partition) {
    partition = crypto.randomUUID();
    sessionStorage.setItem(key, partition);
  }
  return invitationDigest(`cubby.invitation.partition.v1:${partition}`);
}

export function invitationOperationId() {
  return crypto.randomUUID();
}

export async function invitationFingerprint(scope: string, values: Record<string, unknown>) {
  const canonical = Object.keys(values).sort().map((key) => [key, values[key]]);
  return invitationDigest(`cubby.invitation.ui.v1:${scope}:${JSON.stringify(canonical)}`);
}
