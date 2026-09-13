// @vitest-environment jsdom
import React, { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.React = React;

const mocks = vi.hoisted(() => ({ signIn: vi.fn(), push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
vi.mock("@/lib/auth/client", () => ({ authClient: { signIn: { email: mocks.signIn } } }));

import { AuthForm } from "@/components/auth/auth-form";

beforeEach(() => {
  mocks.signIn.mockReset();
  mocks.push.mockReset();
  mocks.refresh.mockReset();
});
afterEach(() => cleanup());

describe("AuthForm", () => {
  it("provides typed credential inputs with password-manager autocomplete and initial email focus", () => {
    render(createElement(AuthForm));

    const email = screen.getByLabelText("Email") as HTMLInputElement;
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(email.type).toBe("email");
    expect(email.autocomplete).toBe("username");
    expect(password.type).toBe("password");
    expect(password.autocomplete).toBe("current-password");
    expect(document.activeElement).toBe(email);
  });

  it("submits only typed credentials and focuses a generic assertive accessible error", async () => {
    mocks.signIn.mockResolvedValue({ error: { message: "Provider disclosed an account-specific failure." } });
    render(createElement(AuthForm, { next: "/app?babyId=baby-1" }));

    await userEvent.type(screen.getByLabelText("Email"), "casey@example.test");
    await userEvent.type(screen.getByLabelText("Password"), "current-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(mocks.signIn).toHaveBeenCalledWith({ email: "casey@example.test", password: "current-password", rememberMe: true, callbackURL: "/invite/dispatch" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe("Unable to sign in right now. Try again.");
    expect(error.textContent).not.toContain("Provider disclosed");
    expect(error.getAttribute("aria-live")).toBe("assertive");
    expect(error.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(error);
    expect(screen.getByLabelText("Email").getAttribute("aria-describedby")).toBe(error.id);
    expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBe("true");
  });
});
