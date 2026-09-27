import { randomBytes } from "node:crypto";
import { dispatchEmailChangeDelivery } from "@/server/services/email-change-delivery";
import { dispatchInvitationEmailDelivery } from "@/server/services/invitation-email-delivery";

type Dispatch = typeof dispatchEmailChangeDelivery;
type BatchDependencies = {
  database: Parameters<Dispatch>[0];
  cipher: Parameters<Dispatch>[2]["cipher"];
  smtp: Parameters<Dispatch>[2]["smtp"];
  dispatch?: Dispatch;
  dispatchInvitation?: typeof dispatchInvitationEmailDelivery;
  workerToken?: () => string;
};

export async function runEmailDeliveryBatch(deps: BatchDependencies, limit = 100) {
  const workerToken = deps.workerToken ?? (() => randomBytes(16).toString("base64url"));
  let accepted = 0;
  let failed = 0;
  let idle = true;
  // Email-change security mail drains first; household invitations share the same transport and budget.
  for (const dispatch of [deps.dispatch ?? dispatchEmailChangeDelivery, deps.dispatchInvitation ?? dispatchInvitationEmailDelivery]) {
    let drained = false;
    for (let index = 0; index < limit; index += 1) {
      const result = await dispatch(deps.database, workerToken(), { cipher: deps.cipher, smtp: deps.smtp });
      if (result.status === "idle") { drained = true; break; }
      if (result.status === "accepted") accepted += 1;
      else failed += 1;
    }
    idle &&= drained;
  }
  return { accepted, failed, idle };
}

export async function runEmailDeliveryWorkerTick() {
  const [{ emailDeliveryPrisma }, { createEmailDeliveryCipher }, { createSmtpEmailDeliveryAdapter }] = await Promise.all([
    import("@/lib/db/email-delivery-prisma"),
    import("@/server/services/email-change-delivery"),
    import("@/server/services/smtp-email-delivery")
  ]);
  return runEmailDeliveryBatch({ database: emailDeliveryPrisma, cipher: createEmailDeliveryCipher(), smtp: createSmtpEmailDeliveryAdapter() });
}
