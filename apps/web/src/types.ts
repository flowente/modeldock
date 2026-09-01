export type UpdateModelAccessInput = {
  modelName: string;
  enabled?: boolean;
  loaded?: boolean;
  groupGrants?: Record<string, boolean>;
};

export type ModelRuntimeAction = "loading" | "unloading";
export type ThemePreference = "light" | "dark";
export type LanguagePreference = "it" | "en";
export type BackgroundPreference = "warm" | "sand" | "mint" | "graphite";
export type ViewId = "welcome" | "home" | "models" | "devices" | "usage" | "onboarding" | "settings" | "diagnostics";

export type AppSettings = {
  background: BackgroundPreference;
  chatUrl: string;
  language: LanguagePreference;
  ollamaModelsPath: string;
  openWebUIInstallPath: string;
  openWebUIAdminEmail: string;
  openWebUIAdminName: string;
  serverAccessUrl: string;
  serverName: string;
  setupComplete: boolean;
  theme: ThemePreference;
};

export const DEFAULT_SETTINGS: AppSettings = {
  background: "warm",
  chatUrl: "",
  language: "it",
  ollamaModelsPath: "C:\\Users\\<utente>\\.ollama\\models",
  openWebUIInstallPath: "",
  openWebUIAdminEmail: "",
  openWebUIAdminName: "Admin",
  serverAccessUrl: "",
  serverName: "Flowente",
  setupComplete: false,
  theme: "light"
};
