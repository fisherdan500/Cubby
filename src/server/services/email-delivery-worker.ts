import { randomBytes } from "node:crypto";
import { dispatchEmailChangeDelivery } from "@/server/services/email-change-delivery";

type Dispatch = typeof dispatchEmailChangeDelivery;
type BatchDependencies = {
  database: Parameters<Dispatch>[0];
  cipher: Parameters<Dispatch>[2]["cipher"];
  smtp: Parameters<Dispatch>[2]["smtp"];
  dispatch?: Dispatch;
  workerToken?: () => string;
};

export async function runEmailDeliveryBatch(deps: BatchDependencies, limit = 100) {
  const dispatch = deps.dispatch ?? dispatchEmailChangeDelivery;
  const workerToken = deps.workerToken ?? (() => randomBytes(16).toString("base64url"));
  let accepted = 0;
  let failed = 0;
  for (let index = 0; index < limit; index += 1) {
    const result = await dispatch(deps.database, workerToken(), { cipher: deps.cipher, smtp: deps.smtp });
    if (result.status === "idle") return { accepted, failed, idle: true };
    if (result.status === "accepted") accepted += 1;
    else failed += 1;
  }
  return { accepted, failed, idle: false };
}

export async function runEmailDeliveryWorkerTick() {
  const [{ emailDeliveryPrisma }, { createEmailDeliveryCipher }, { createSmtpEmailDeliveryAdapter }] = await Promise.all([
    import("@/lib/db/email-delivery-prisma"),
    import("@/server/services/email-change-delivery"),
    import("@/server/services/smtp-email-delivery")
  ]);
  return runEmailDeliveryBatch({ database: emailDeliveryPrisma, cipher: createEmailDeliveryCipher(), smtp: createSmtpEmailDeliveryAdapter() });
}
