import { describe, expect, it } from "vitest";
import { canUseModel, listAllowedModels, setModelEnabled, setModelLoaded, type ModelAccessPolicy, type UserAccessContext } from "./model-access.js";

const operator: UserAccessContext = {
  userId: "usr-simone",
  role: "operator",
  groupIds: ["grp-builders"]
};

const llamaPolicy: ModelAccessPolicy = {
  modelName: "llama3.1:8b",
  enabled: true,
  loaded: false,
  grants: [
    {
      subject: { type: "group", id: "grp-builders" },
      canUse: true
    }
  ]
};

describe("model access control", () => {
  it("allows model usage through group grants", () => {
    expect(canUseModel(llamaPolicy, operator)).toBe(true);
  });

  it("blocks model usage when the model is disabled", () => {
    expect(canUseModel(setModelEnabled(llamaPolicy, false), operator)).toBe(false);
  });

  it("keeps enabled and loaded as separate states", () => {
    const loadedPolicy = setModelLoaded(llamaPolicy, true);

    expect(loadedPolicy.enabled).toBe(true);
    expect(loadedPolicy.loaded).toBe(true);
  });

  it("filters the model list using the access matrix", () => {
    const privatePolicy: ModelAccessPolicy = {
      modelName: "private-coder:latest",
      enabled: true,
      loaded: false,
      grants: [
        {
          subject: { type: "user", id: "usr-admin" },
          canUse: true
        }
      ]
    };

    expect(listAllowedModels([llamaPolicy, privatePolicy], operator).map((policy) => policy.modelName)).toEqual(["llama3.1:8b"]);
  });
});
