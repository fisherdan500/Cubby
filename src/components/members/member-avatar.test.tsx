// @vitest-environment jsdom
/**
 * A member's picture in the places people actually look.
 *
 * A 32px circle is too small to see a face, so tapping one opens it properly. A member with no
 * picture shows their initials and is not a button, because there is nothing to open.
 */
import React, { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { MemberAvatar } from "./member-avatar";

afterEach(cleanup);

const withPhoto = { name: "Avery Fisher", photoAttachmentId: "att-1" };
const withoutPhoto = { name: "Avery Fisher", photoAttachmentId: null };

describe("a member's avatar", () => {
  it("shows the member's initials when they have no picture", () => {
    render(createElement(MemberAvatar, withoutPhoto));
    expect(screen.getByText("AF")).toBeTruthy();
  });

  it("is not clickable when there is no picture to open", () => {
    render(createElement(MemberAvatar, withoutPhoto));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the picture when the member has one", () => {
    render(createElement(MemberAvatar, withPhoto));
    const image = screen.getByRole("img", { name: "Avery Fisher" }) as HTMLImageElement;
    // The small copy: a feed scrolls past dozens of these.
    expect(image.getAttribute("src")).toBe("/api/attachments/att-1?size=thumbnail");
  });

  it("opens the picture full size when tapped", async () => {
    const user = userEvent.setup();
    render(createElement(MemberAvatar, withPhoto));

    await user.click(screen.getByRole("button", { name: "Open Avery Fisher's picture" }));

    const dialog = screen.getByRole("dialog", { name: "Avery Fisher" });
    const full = dialog.querySelector("img") as HTMLImageElement;
    // Full size here, because seeing the face is the entire point of opening it.
    expect(full.getAttribute("src")).toBe("/api/attachments/att-1");
  });

  it("closes again", async () => {
    const user = userEvent.setup();
    render(createElement(MemberAvatar, withPhoto));

    await user.click(screen.getByRole("button", { name: "Open Avery Fisher's picture" }));
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape, because a photo should never trap someone", async () => {
    const user = userEvent.setup();
    render(createElement(MemberAvatar, withPhoto));

    await user.click(screen.getByRole("button", { name: "Open Avery Fisher's picture" }));
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the person for a screen reader rather than saying 'image'", () => {
    render(createElement(MemberAvatar, withPhoto));
    expect(screen.getByRole("img", { name: "Avery Fisher" })).toBeTruthy();
  });
});
