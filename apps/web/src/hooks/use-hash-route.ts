import { useEffect, useState } from "react";
import type { ViewId } from "../types.js";

export function useHashRoute() {
  const [activeView, setActiveView] = useState<ViewId>(getInitialView);

  useEffect(() => {
    function handleHashChange() {
      setActiveView(parseViewHash(window.location.hash));
    }

    window.addEventListener("hashchange", handleHashChange);
    handleHashChange();

    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  return activeView;
}

function getInitialView(): ViewId {
  if (typeof window === "undefined") {
    return "welcome";
  }

  return parseViewHash(window.location.hash);
}

function parseViewHash(hash: string): ViewId {
  const value = hash.replace("#", "");

  if (value === "system") {
    return "home";
  }

  if (value === "tailscale" || value === "network") {
    return "devices";
  }

  if (["welcome", "home", "models", "devices", "usage", "onboarding", "settings", "diagnostics"].includes(value)) {
    return value as ViewId;
  }

  return "welcome";
}
