import { describe, expect, it } from "vitest";
import { can } from "./index.js";

describe("role permissions", () => {
  it("allows admins to delete models", () => {
    expect(can("admin", "models:delete")).toBe(true);
  });

  it("prevents viewers from deleting models", () => {
    expect(can("viewer", "models:delete")).toBe(false);
  });
});

