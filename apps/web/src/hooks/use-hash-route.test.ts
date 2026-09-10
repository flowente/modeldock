import { describe, expect, it } from "vitest";

import { parseViewHash } from "./use-hash-route.js";

describe("parseViewHash", () => {
  it("resolves known views regardless of setup state", () => {
    expect(parseViewHash("#models", false)).toBe("models");
    expect(parseViewHash("#welcome", true)).toBe("welcome");
  });

  it("maps legacy aliases", () => {
    expect(parseViewHash("#system", true)).toBe("home");
    expect(parseViewHash("#tailscale", true)).toBe("devices");
  });

  it("sends an empty or unknown hash to the wizard before setup", () => {
    expect(parseViewHash("", false)).toBe("welcome");
    expect(parseViewHash("#nonsense", false)).toBe("welcome");
  });

  it("sends an empty or unknown hash to the dashboard after setup (no wizard trap)", () => {
    expect(parseViewHash("", true)).toBe("home");
    expect(parseViewHash("#nonsense", true)).toBe("home");
  });
});
