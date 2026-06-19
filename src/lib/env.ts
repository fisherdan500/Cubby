import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(16),
  BETTER_AUTH_URL: z.string().url(),
  TRUSTED_ORIGINS: z.string().optional(),
  ENABLE_REGISTRATION: z.string().default("true"),
  ALLOW_PUBLIC_REGISTRATION: z.string().default("false")
});

export const env = envSchema.parse({
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://cubby:cubby_password@localhost:5432/cubby?schema=public",
  BETTER_AUTH_SECRET:
    process.env.BETTER_AUTH_SECRET ??
    "development-only-secret-change-me-before-deploying",
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  TRUSTED_ORIGINS: process.env.TRUSTED_ORIGINS,
  ENABLE_REGISTRATION: process.env.ENABLE_REGISTRATION ?? "true",
  ALLOW_PUBLIC_REGISTRATION: process.env.ALLOW_PUBLIC_REGISTRATION ?? "false"
});

export function trustedOrigins() {
  const configured =
    env.TRUSTED_ORIGINS?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];
  const origins = configured.length ? configured : [env.BETTER_AUTH_URL];
  const expanded = new Set<string>();

  for (const origin of origins) {
    expanded.add(origin);
    const alias = loopbackAlias(origin);
    if (alias) expanded.add(alias);
  }

  return [...expanded];
}

function loopbackAlias(origin: string) {
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1";
      return url.origin;
    }
    if (url.hostname === "127.0.0.1") {
      url.hostname = "localhost";
      return url.origin;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
