export function createEmailChangeVerificationCarrier() {
  let active = false;
  return {
    async submit<T>(token: string, send: (token: string) => Promise<T>) {
      if (!token || active) throw new Error("email_change_verification_carrier_unavailable");
      active = true;
      try {
        return await send(token);
      } finally {
        token = "";
        active = false;
      }
    },
    hasActiveSecret() {
      return active;
    }
  };
}
