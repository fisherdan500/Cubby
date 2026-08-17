import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { MemberAccessManager } from "@/components/settings/member-access-manager";

globalThis.React = React;

const source = readFileSync(fileURLToPath(new URL("./member-access-manager.tsx", import.meta.url)), "utf8");

describe("MemberAccessManager", () => {
  it("sends a retained browser-v2 operation identity for every member mutation", () => {
    expect(source).toContain("const memberOperationIds = useRef(new Map<string, string>());");
    expect(source).toContain("operationId: memberOperationId(memberId, \"role.update\")");
    expect(source).toContain("operationId: memberOperationId(member.id, suspending ? \"suspend\" : \"restore\")");
    expect(source).toContain("operationId: memberOperationId(member.id, \"remove\")");
    expect(source).toContain("headers: { \"content-type\": \"application/json\" }");
  });

  it("clearly distinguishes active and suspended members with reversible controls", () => {
    const html = renderToStaticMarkup(createElement(MemberAccessManager, {
      viewerRole: "owner",
      members: [
        { id: "owner", name: "Owner", email: "owner@example.com", role: "owner", disabledAt: null },
        { id: "active", name: "Jordan", email: "active@example.com", role: "parent", disabledAt: null },
        {
          id: "suspended",
          name: "Casey",
          email: "suspended@example.com",
          role: "admin",
          disabledAt: "2026-07-14T12:00:00.000Z"
        }
      ],
      invites: []
    }));

    const ownerCard = html.slice(html.indexOf("owner@example.com"), html.indexOf("active@example.com"));
    const activeCard = html.slice(html.indexOf("active@example.com"), html.indexOf("suspended@example.com"));
    const suspendedCard = html.slice(html.indexOf("suspended@example.com"), html.indexOf("Pending invites"));

    expect(activeCard).toContain("Active");
    expect(activeCard).toContain("Save");
    expect(activeCard).toContain("Suspend");
    expect(activeCard).toContain("Remove");

    expect(suspendedCard).toContain("Suspended");
    expect(suspendedCard).toContain("Restore access");
    expect(suspendedCard).not.toContain("Save");
    expect(suspendedCard).not.toContain("Remove");
    expect(suspendedCard).not.toContain("<select");

    expect(ownerCard).toContain("The household owner is protected.");
    expect(ownerCard).not.toContain("Save");
    expect(ownerCard).not.toContain("Suspend");
    expect(ownerCard).not.toContain("Remove");
    expect(html).toContain("min-w-0");
    expect(html).toContain("break-all");
  });
});
