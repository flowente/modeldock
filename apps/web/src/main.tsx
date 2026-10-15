import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "./chat/ChatApp.tsx";

const RELOAD_FLAG = "modeldock.reloaded-for-update";

/**
 * A tab opened before an update still points at the old file names, which no longer
 * exist: reload once to pick up the new ones instead of showing a blank page.
 */
const LegacyDashboard = lazy(() =>
  import("./legacy.tsx").then(
    (module) => {
      sessionStorage.removeItem(RELOAD_FLAG);
      return module;
    },
    (error: unknown) => {
      if (sessionStorage.getItem(RELOAD_FLAG)) throw error;
      sessionStorage.setItem(RELOAD_FLAG, "1");
      window.location.reload();
      return new Promise<never>(() => undefined);
    }
  )
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

/** The chat lives at "#/…" (and at the bare address); the dashboard keeps its old hashes ("#home", "#models"…). */
export function isChatHash(hash: string): boolean {
  return hash === "" || hash === "#" || hash.startsWith("#/");
}

function Root() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  if (isChatHash(hash)) return <ChatApp />;
  return (
    <Suspense fallback={null}>
      <LegacyDashboard />
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </React.StrictMode>
);
