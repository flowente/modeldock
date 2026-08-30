import { useEffect, useState } from "react";
import { DEFAULT_SETTINGS, type AppSettings } from "../types.js";

const SETTINGS_STORAGE_KEY = "modeldock:settings";

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(readSettings);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
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
      chatUrl: typeof parsed.chatUrl === "string" ? parsed.chatUrl : DEFAULT_SETTINGS.chatUrl,
      serverName: typeof parsed.serverName === "string" && parsed.serverName.trim() ? parsed.serverName : DEFAULT_SETTINGS.serverName,
      theme: parsed.theme === "dark" ? "dark" : DEFAULT_SETTINGS.theme
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}
