export type UpdateModelAccessInput = {
  modelName: string;
  enabled?: boolean;
  loaded?: boolean;
  groupGrants?: Record<string, boolean>;
};

export type ModelRuntimeAction = "loading" | "unloading";
export type ThemePreference = "light" | "dark";
export type ViewId = "home" | "models" | "devices" | "usage" | "onboarding" | "settings" | "diagnostics";

export type AppSettings = {
  chatUrl: string;
  serverName: string;
  theme: ThemePreference;
};

export const DEFAULT_SETTINGS: AppSettings = {
  chatUrl: "",
  serverName: "Flowente",
  theme: "light"
};
