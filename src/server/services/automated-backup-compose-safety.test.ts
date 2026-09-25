import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const compose = readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
const envExample = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");

describe("automated backup compose safety", () => {
  it("bind mounts the dedicated local backup directory into the app container", () => {
    expect(compose).toContain('${CUBBY_BACKUP_HOST_DIR:-./docker-data/backups}:/var/lib/cubby/backups');
    expect(compose).not.toContain('/var/lib/postgresql/data:/var/lib/cubby/backups');
    expect(envExample).toContain('CUBBY_BACKUP_HOST_DIR=./docker-data/backups');
  });

  it("bind mounts the private photo store beside backups, never inside the image", () => {
    expect(compose).toContain("${CUBBY_ATTACHMENT_HOST_DIR:-./docker-data/attachments}:/var/lib/cubby/attachments");
    expect(envExample).toContain("CUBBY_ATTACHMENT_HOST_DIR=./docker-data/attachments");
    expect(dockerfile).not.toContain("/var/lib/cubby/attachments");
  });

  it("keeps persistence exclusively in the bind mount and avoids remote secrets", () => {
    expect(dockerfile).not.toContain('/var/lib/cubby/backups');
    expect(envExample).not.toContain('AWS_');
    expect(envExample).not.toContain('S3_');
    expect(envExample).not.toContain('BACKUP_ENCRYPTION');
    expect(envExample).toContain('AUTOMATED_BACKUPS_ENABLED=false');
  });
});
