import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against the real API serving the built chat (run `pnpm build` first).
 * Demo Ollama, a throwaway in-memory database, no device connection.
 */
export default defineConfig({
  testDir: "./apps/web/e2e",
  use: {
    baseURL: "http://127.0.0.1:4318"
  },
  webServer: {
    command: "node --experimental-strip-types apps/api/src/server.ts",
    env: {
      MODELDOCK_OLLAMA_MODE: "fake",
      MODELDOCK_API_PORT: "4318",
      MODELDOCK_DATABASE_PATH: ":memory:",
      MODELDOCK_LINK: "false"
    },
    url: "http://127.0.0.1:4318/api/health",
    reuseExistingServer: false
  }
});
