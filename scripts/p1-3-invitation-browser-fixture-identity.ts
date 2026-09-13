// Better Auth finds users by the lowercased submitted email with a case-sensitive equality, so an identity
// seeded directly into the database must be stored the way sign-up would store it or it can never sign in.
export function p13SeededFixtureEmail(kind: "owner" | "existing", suffix: string) {
  return `p13-browser-${kind}-${suffix}@acceptance.invalid`.toLowerCase();
}
