import { describe, expect, it } from "vitest";
import { readAttachmentConfig } from "@/lib/attachment-config";

describe("attachment configuration", () => {
  it("defaults to the data volume beside backups", () => {
    expect(readAttachmentConfig({})).toEqual({ directory: "/var/lib/cubby/attachments" });
    expect(readAttachmentConfig({ ATTACHMENT_DIRECTORY: " /srv/cubby/attachments " })).toEqual({ directory: "/srv/cubby/attachments" });
  });

  it("refuses a blank, root or traversing directory", () => {
    for (const value of ["", "   ", "/", "C:\\", "/srv/../etc"]) {
      expect(() => readAttachmentConfig({ ATTACHMENT_DIRECTORY: value })).toThrow(/ATTACHMENT_DIRECTORY/);
    }
  });
});
