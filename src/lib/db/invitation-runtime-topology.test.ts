import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("invitation runtime topology", () => {
  it("uses three dedicated invitation login URLs and withholds household deletion", () => {
    const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
    const entrypoint = readFileSync(new URL("../../../docker/entrypoint.sh", import.meta.url), "utf8");
    const provisioner = readFileSync(new URL("../../../scripts/provision-invitation-runtime-roles.mjs", import.meta.url), "utf8");

    const roles = [
      ["cubby_invitation_runtime", "INVITATION_DATABASE_URL", "CUBBY_INVITATION_RUNTIME_DB_PASSWORD"],
      ["cubby_invitation_expiry_worker", "INVITATION_EXPIRY_DATABASE_URL", "CUBBY_INVITATION_EXPIRY_DB_PASSWORD"],
      ["cubby_invitation_maintenance_worker", "INVITATION_MAINTENANCE_DATABASE_URL", "CUBBY_INVITATION_MAINTENANCE_DB_PASSWORD"],
    ] as const;

    for (const [role, url, password] of roles) {
      expect(compose).toContain(`${url}: postgresql://${role}:`);
      expect(compose).toContain(`${password}:`);
      expect(entrypoint).toContain(url);
      expect(entrypoint).toContain(password);
      expect(provisioner).toContain(`"${role}"`);
      expect(provisioner).toContain("NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
      expect(provisioner).toContain("cubby_restricted_role_owns_objects");
    }

    expect(entrypoint.indexOf("provision-invitation-runtime-roles.mjs")).toBeLessThan(entrypoint.indexOf("migrate deploy"));
    expect(entrypoint).toMatch(/unset[^\n]*CUBBY_INVITATION_RUNTIME_DB_PASSWORD[^\n]*CUBBY_INVITATION_EXPIRY_DB_PASSWORD[^\n]*CUBBY_INVITATION_MAINTENANCE_DB_PASSWORD/);
    for (const forbidden of ["cubby_household_delete_runtime", "HOUSEHOLD_DELETE_DATABASE_URL", "CUBBY_HOUSEHOLD_DELETE_DB_PASSWORD"]) {
      expect(compose).not.toContain(forbidden);
      expect(entrypoint).not.toContain(forbidden);
      expect(provisioner).not.toContain(forbidden);
    }
  });
});
