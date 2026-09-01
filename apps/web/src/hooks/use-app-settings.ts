import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, type AppSettings } from "../types.js";

const SETTINGS_STORAGE_KEY = "modeldock:settings";

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(readSettings);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    document.documentElement.dataset.background = settings.background;
    document.documentElement.dataset.theme = settings.theme;
  }, [settings]);

  function updateSettings(next: Partial<AppSettings>) {
    setSettings((current) => ({
      ...current,
      ...next
    }));
  }

  return {
    defaultSettings: DEFAULT_SETTINGS,
    settings,
    updateSettings
  };
}

function readSettings(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<AppSettings>) : {};

    return {
      background: isBackgroundPreference(parsed.background) ? parsed.background : DEFAULT_SETTINGS.background,
      chatUrl: typeof parsed.chatUrl === "string" ? parsed.chatUrl : DEFAULT_SETTINGS.chatUrl,
      language: parsed.language === "en" ? "en" : DEFAULT_SETTINGS.language,
      ollamaModelsPath: typeof parsed.ollamaModelsPath === "string" ? parsed.ollamaModelsPath : DEFAULT_SETTINGS.ollamaModelsPath,
      openWebUIAdminEmail: typeof parsed.openWebUIAdminEmail === "string" ? parsed.openWebUIAdminEmail : DEFAULT_SETTINGS.openWebUIAdminEmail,
      openWebUIAdminName: typeof parsed.openWebUIAdminName === "string" && parsed.openWebUIAdminName.trim() ? parsed.openWebUIAdminName : DEFAULT_SETTINGS.openWebUIAdminName,
      openWebUIInstallPath: typeof parsed.openWebUIInstallPath === "string" ? parsed.openWebUIInstallPath : DEFAULT_SETTINGS.openWebUIInstallPath,
      serverAccessUrl: typeof parsed.serverAccessUrl === "string" ? parsed.serverAccessUrl : DEFAULT_SETTINGS.serverAccessUrl,
      serverName: typeof parsed.serverName === "string" && parsed.serverName.trim() ? parsed.serverName : DEFAULT_SETTINGS.serverName,
      setupComplete: parsed.setupComplete === true,
      theme: DEFAULT_SETTINGS.theme
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function isBackgroundPreference(value: unknown): value is AppSettings["background"] {
  return value === "warm" || value === "sand" || value === "mint" || value === "graphite";
}
