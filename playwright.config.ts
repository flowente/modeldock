import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  use: {
    baseURL: "http://127.0.0.1:4174"
  },
  webServer: [
    {
      command: "node --experimental-strip-types apps/api/src/server.ts",
      env: {
        MODELDOCK_OLLAMA_MODE: "fake",
        MODELDOCK_API_PORT: "4318",
        MODELDOCK_TAILSCALE_MODE: "fake"
      },
      url: "http://127.0.0.1:4318/api/health",
      reuseExistingServer: false
    },
    {
      command: "cd apps/web && ..\\..\\node_modules\\.bin\\vite.cmd preview --configLoader runner --host 127.0.0.1",
      env: {
        MODELDOCK_WEB_API_PROXY_URL: "http://127.0.0.1:4318",
        MODELDOCK_WEB_PREVIEW_PORT: "4174"
      },
      url: "http://127.0.0.1:4174",
      reuseExistingServer: false
    }
  ]
});
