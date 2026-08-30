import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(process.cwd(), "prisma/migrations/20260829120000_global_security_throttle_core/migration.sql"), "utf8");
const provisioner = readFileSync(resolve(process.cwd(), "scripts/provision-global-security-throttle-key.mjs"), "utf8");

describe("global security throttle-key provisioner", () => {
  it("creates an empty owner-only digest table before post-migration provisioning", () => {
    expect(migration).toContain('CREATE TABLE "GlobalSecurityThrottleKey"');
    expect(migration).not.toContain('INSERT INTO "GlobalSecurityThrottleKey"');
    expect(migration).toContain('REVOKE ALL ON TABLE "GlobalSecurityEvent","GlobalSecurityIncident","GlobalSecurityThrottleKey" FROM PUBLIC');
  });

  it("inserts a fresh singleton, verifies an exact existing digest with database time, and fails closed without rotation", () => {
    expect(provisioner).toContain('CUBBY_THROTTLE_KEY');
    expect(provisioner).toContain('key.length !== 32');
    expect(provisioner).toContain('data: { singletonId: 1, keyDigest }');
    expect(provisioner).toContain('UPDATE "GlobalSecurityThrottleKey" SET "verifiedAt"=clock_timestamp()');
    expect(provisioner).toContain('timingSafeEqual');
    expect(provisioner).not.toContain('update: { keyDigest');
    expect(provisioner).not.toContain('configured');
    expect(provisioner).toContain('cubby_startup phase=global_security_throttle_key status=failed');
    expect(provisioner).not.toContain('process.stderr.write(error');
  });
});
