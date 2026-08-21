import { createHash } from "node:crypto";
import { getEffectiveHouseholdContext } from "@/server/auth/context";
import { getSession } from "@/server/auth/session";

export type BrowserOperationPartition = {
  version: 1;
  scope: "household" | "account";
  partition: string;
};

function opaquePartition(scope: BrowserOperationPartition["scope"], values: Record<string, string>): BrowserOperationPartition {
  const canonical = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
  return {
    version: 1,
    scope,
    partition: createHash("sha256").update(`cubby.browser-operation-partition:v1:${scope}:${canonical}`).digest("hex")
  };
}

async function requireSession() {
  const session = await getSession();
  if (!session?.user || !session.session) throw new Error("unauthenticated");
  return session;
}

export async function getHouseholdBrowserOperationPartition(): Promise<BrowserOperationPartition> {
  const [context, session] = await Promise.all([getEffectiveHouseholdContext(), requireSession()]);
  if (context.userId !== session.user.id) throw new Error("forbidden");
  return opaquePartition("household", {
    householdId: context.householdId,
    memberId: context.memberId,
    sessionId: session.session.id,
    userId: session.user.id
  });
}

export async function getAccountBrowserOperationPartition(): Promise<BrowserOperationPartition> {
  const session = await requireSession();
  return opaquePartition("account", { sessionId: session.session.id, userId: session.user.id });
}
