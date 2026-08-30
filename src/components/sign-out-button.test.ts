// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import React, { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));

import { SignOutButton } from "@/components/sign-out-button";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe("SignOutButton", () => {
  it("opens the confirmed private current-session flow instead of claiming framework logout", () => {
    render(createElement(SignOutButton));

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(mocks.push).toHaveBeenCalledWith("/app/settings/sessions");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
