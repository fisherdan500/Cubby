import { describe, expect, it } from "vitest";
import {
  clearRegistrationPendingOperation,
  readRegistrationPendingOperation,
  registrationDraftForStorage,
  registrationIntentMatches,
  storeRegistrationPendingOperation
} from "@/components/settings/registration-settings-form";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  };
}

describe("registration settings operation recovery", () => {
  it("persists a server-issued operation and only reuses it for the identical intent", () => {
    const sessionStorage = storage();
    const intent = { householdCreationMode: "open" as const, allowPublicRegistration: true };

    storeRegistrationPendingOperation(sessionStorage, { operationId: "op_server_opaque_123", intent });

    expect(readRegistrationPendingOperation(sessionStorage)).toEqual({ operationId: "op_server_opaque_123", intent });
    expect(registrationIntentMatches(readRegistrationPendingOperation(sessionStorage)?.intent, intent)).toBe(true);
    expect(registrationIntentMatches(readRegistrationPendingOperation(sessionStorage)?.intent, {
      householdCreationMode: "closed",
      allowPublicRegistration: true
    })).toBe(false);
  });

  it("rejects malformed browser state and clears terminal outcomes", () => {
    const sessionStorage = storage();
    sessionStorage.setItem("cubby.platform-registration.pending-operation", '{"operationId":3}');

    expect(readRegistrationPendingOperation(sessionStorage)).toBeNull();

    storeRegistrationPendingOperation(sessionStorage, {
      operationId: "op_server_opaque_123",
      intent: { householdCreationMode: "closed", allowPublicRegistration: false }
    });
    clearRegistrationPendingOperation(sessionStorage);
    expect(readRegistrationPendingOperation(sessionStorage)).toBeNull();
  });

  it("rehydrates a persisted intent rather than reverting pending recovery to server defaults", () => {
    const sessionStorage = storage();
    const serverDefaults = { householdCreationMode: "closed" as const, allowPublicRegistration: false };
    const pendingIntent = { householdCreationMode: "open" as const, allowPublicRegistration: true };

    storeRegistrationPendingOperation(sessionStorage, { operationId: "op_server_opaque_123", intent: pendingIntent });

    expect(registrationDraftForStorage(sessionStorage, serverDefaults)).toEqual(pendingIntent);
  });
});
