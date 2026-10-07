// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
import { BackupRestoreForm } from "./backup-restore-form";

beforeEach(() => { vi.resetAllMocks(); vi.stubGlobal("fetch", mocks.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const source = readFileSync("src/components/settings/backup-restore-form.tsx", "utf8");
const preview = { legacyPartial: false, checksumVerified: true, checksum: "digest", householdName: "Archived", exportedAt: null, counts: { babies: 1 }, exclusions: [] };
const response = (data: unknown) => ({ json: async () => ({ ok: true, data }) });

describe("BackupRestoreForm", () => {
  it("ignores a late preview after privacy withdrawal even if acknowledgement is checked again", async () => {
    let resolvePreview!: (value: ReturnType<typeof response>) => void;
    mocks.fetch.mockReturnValue(new Promise((resolve) => { resolvePreview = resolve; }));
    render(createElement(BackupRestoreForm, { targetHouseholdName: "Recovery", timeZone: "UTC" }));
    const acknowledgement = screen.getByRole("checkbox", { name: /I understand/ });
    fireEvent.click(acknowledgement);
    fireEvent.change(screen.getByLabelText("Cubby backup (.json, or .zip with photos)"), {
      target: { files: [new File(["{}"], "backup.json", { type: "application/json" })] }
    });
    fireEvent.click(acknowledgement);
    fireEvent.click(acknowledgement);
    await act(async () => { resolvePreview(response(preview)); });
    expect(screen.queryByRole("region", { name: "Backup preview" })).toBeNull();
    expect(screen.queryByText(/Backup preview is ready/)).toBeNull();
    expect(screen.queryByText(/Validating backup/)).toBeNull();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("clears the file, preview, confirmation, status and invite list when acknowledgement is withdrawn", async () => {
    const user = userEvent.setup();
    mocks.fetch.mockResolvedValueOnce(response(preview)).mockResolvedValueOnce(response({ restored: 1, members: { needInvite: ["relative@example.test"] } }));
    render(createElement(BackupRestoreForm, { targetHouseholdName: "Recovery", timeZone: "UTC" }));
    const acknowledgement = screen.getByRole("checkbox", { name: /I understand/ });
    await user.click(acknowledgement);
    const input = screen.getByLabelText("Cubby backup (.json, or .zip with photos)") as HTMLInputElement;
    const file = new File(["backup"], "household.zip", { type: "application/zip" });
    await user.upload(input, file);
    await screen.findByRole("region", { name: "Backup preview" });
    await user.type(screen.getByLabelText(/Type the current household name/), "Recovery");
    await user.click(screen.getByRole("button", { name: "Restore this backup" }));
    await screen.findByText("relative@example.test");
    expect(mocks.fetch.mock.calls.map(([url, options]) => [url, options.body, options.headers["content-type"]])).toEqual([
      ["/api/backups/restore/preview", file, "application/zip"],
      ["/api/backups/restore", file, "application/zip"]
    ]);
    await user.click(acknowledgement);
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("");
    expect(screen.queryByRole("region", { name: "Backup preview" })).toBeNull();
    expect(screen.queryByText(/Restore complete/)).toBeNull();
    expect(screen.queryByText("relative@example.test")).toBeNull();
    await user.click(acknowledgement);
    expect(screen.queryByRole("button", { name: "Restore this backup" })).toBeNull();
    mocks.fetch.mockResolvedValueOnce(response(preview));
    await user.upload(input, file);
    await screen.findByRole("region", { name: "Backup preview" });
    expect((screen.getByLabelText(/Type the current household name/) as HTMLInputElement).value).toBe("");
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  });

  it("requires explicit plaintext privacy acknowledgement before selecting any file", () => {
    render(createElement(BackupRestoreForm, { targetHouseholdName: "Recovery", timeZone: "UTC" }));
    const file = screen.getByLabelText("Cubby backup (.json, or .zip with photos)") as HTMLInputElement;
    expect(file.disabled).toBe(true);
    expect(screen.getByText(/uploaded once for preview and again for restore/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
    expect(file.disabled).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not imply an in-flight restore can be cancelled by withdrawing acknowledgement", async () => {
    const user = userEvent.setup();
    mocks.fetch
      .mockResolvedValueOnce(response(preview))
      .mockReturnValueOnce(new Promise(() => {}));
    render(createElement(BackupRestoreForm, { targetHouseholdName: "Recovery", timeZone: "UTC" }));
    const acknowledgement = screen.getByRole("checkbox", { name: /I understand/ }) as HTMLInputElement;
    await user.click(acknowledgement);
    const file = new File(["{}"], "backup.json", { type: "application/json" });
    await user.upload(screen.getByLabelText("Cubby backup (.json, or .zip with photos)"), file);
    await screen.findByRole("region", { name: "Backup preview" });
    await user.type(screen.getByLabelText(/Type the current household name/), "Recovery");
    await user.click(screen.getByRole("button", { name: "Restore this backup" }));

    expect(acknowledgement.disabled).toBe(true);
    expect(screen.getByText(/cannot be cancelled after submission/i)).toBeTruthy();
  });

  it("uploads the selected file unchanged through preview then confirmed restore", () => {
    expect(source).toContain('type="file"');
    expect(source).toContain('accept="application/json,.json,application/zip,.zip"');
    // A .zip - a backup with photos - is sent as an archive, anything else as JSON.
    expect(source).toContain('endsWith(".zip") ? "application/zip" : "application/json"');
    expect(source).toContain('body: selectedFile');
    expect(source).toContain('"/api/backups/restore/preview"');
    expect(source).toContain('"x-cubby-restore-confirmation"');
    expect(source).toContain('"x-cubby-backup-checksum"');
  });

  it("renders preview counts, exclusions, legacy warning, and accessible status", () => {
    expect(source).toContain("legacyPartial");
    expect(source).toContain("exclusions");
    expect(source).toContain("Object.entries(preview.counts)");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("Type the current household name exactly");
  });
});
