import { describe, expect, it, vi } from "vitest";
import { withSuspendedSessionErrorTranslation } from "@/server/auth/session-adapter";

describe("suspended session adapter translation", () => {
  it("translates only the dedicated suspended-session trigger signal", async () => {
    const triggerError = new Error(
      'Database error: PostgresError { code: "CUB01", message: "Your account is disabled." }'
    );
    const create = vi.fn().mockRejectedValue(triggerError);
    const adapter = withSuspendedSessionErrorTranslation(() => ({ create }) as never)({} as never);

    await expect(adapter.create({ model: "session", data: {} })).rejects.toMatchObject({
      status: "FORBIDDEN",
      body: {
        code: "ACCOUNT_DISABLED",
        message: "Your account is disabled."
      }
    });
  });

  it("preserves unrelated session and non-session adapter errors", async () => {
    const unrelated = new Error("unrelated database failure");
    const create = vi.fn().mockRejectedValue(unrelated);
    const adapter = withSuspendedSessionErrorTranslation(() => ({ create }) as never)({} as never);

    await expect(adapter.create({ model: "session", data: {} })).rejects.toBe(unrelated);

    create.mockRejectedValue(
      new Error('Database error: PostgresError { code: "CUB01", message: "Your account is disabled." }')
    );
    await expect(adapter.create({ model: "user", data: {} })).rejects.toThrow("CUB01");
  });
});
