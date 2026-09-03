import { useEffect, useState } from "react";
import type { ViewId } from "../types.js";

export function useHashRoute(setupComplete: boolean) {
  const [activeView, setActiveView] = useState<ViewId>(() => getInitialView(setupComplete));

  useEffect(() => {
    function handleHashChange() {
      setActiveView(parseViewHash(window.location.hash, setupComplete));
    }

    window.addEventListener("hashchange", handleHashChange);
    handleHashChange();

    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [setupComplete]);

  return activeView;
}

function getInitialView(setupComplete: boolean): ViewId {
  if (typeof window === "undefined") {
    return setupComplete ? "home" : "welcome";
  }

  return parseViewHash(window.location.hash, setupComplete);
}

export function parseViewHash(hash: string, setupComplete: boolean): ViewId {
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

  // Empty or unknown hash (e.g. a bookmarked "/" or "#"): once the server is set
  // up, land on the dashboard instead of trapping the user back in the wizard.
  return setupComplete ? "home" : "welcome";
}
