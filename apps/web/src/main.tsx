import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "./chat/ChatApp.tsx";

/**
 * Addresses of the old dashboard ("#home", "#models"…) may still be in bookmarks:
 * everything they showed now lives in the settings.
 */
const hash = window.location.hash;
if (hash && hash !== "#" && !hash.startsWith("#/")) {
  window.history.replaceState(null, "", "#/impostazioni/server");
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ChatApp />
    </QueryClientProvider>
  </React.StrictMode>
);
