import { describe, expect, it } from "vitest";
import type { ManagedServerSetupStatus } from "../api.js";
import { formatManagedSetupMessage, shouldShowAdministratorFields } from "./welcome.js";

const downloadingStatus: ManagedServerSetupStatus = {
  state: "running",
  phase: "installing_chat",
  progress: 55,
  message: "Downloading the prepared chat runtime (47%).",
  ollamaReady: true,
  chatReady: false,
  adminReady: false,
  updatedAt: "2026-09-02T00:00:00.000Z"
};

describe("managed setup progress copy", () => {
  it("hides administrator fields while setup is running to keep the download view compact", () => {
    expect(shouldShowAdministratorFields(null)).toBe(true);
    expect(shouldShowAdministratorFields(downloadingStatus)).toBe(false);
    expect(shouldShowAdministratorFields({ ...downloadingStatus, state: "failed", phase: "failed" })).toBe(true);
  });

  it("describes the chat package without rendering a second percentage", () => {
    const message = formatManagedSetupMessage(downloadingStatus, "it");

    expect(message).toContain("OpenWebUI");
    expect(message).toContain("senza installazioni manuali");
    expect(message).not.toMatch(/\d+%/);
  });

  it("keeps the English progress description free of duplicate percentages", () => {
    const message = formatManagedSetupMessage(downloadingStatus, "en");

    expect(message).toContain("OpenWebUI");
    expect(message).not.toMatch(/\d+%/);
  });

  it("translates an existing administrator failure without exposing backend jargon", () => {
    const message = formatManagedSetupMessage(
      {
        ...downloadingStatus,
        state: "failed",
        phase: "failed",
        message: "The local chat already has an administrator. Enter the existing credentials."
      },
      "it"
    );

    expect(message).toContain("contiene già un amministratore");
    expect(message).not.toContain("The local chat");
  });
});
