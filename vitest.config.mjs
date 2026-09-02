import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pathOf = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/api/**/*.test.ts", "apps/web/**/*.test.tsx"],
    coverage: {
      reporter: ["text", "html"]
    }
  },
  resolve: {
    alias: {
      "@modeldock/auth": pathOf("./packages/auth/src/index.ts"),
      "@modeldock/core": pathOf("./packages/core/src/index.ts"),
      "@modeldock/diagnostics": pathOf("./packages/diagnostics/src/index.ts"),
      "@modeldock/observability": pathOf("./packages/observability/src/index.ts"),
      "@modeldock/ollama-adapter": pathOf("./packages/ollama-adapter/src/index.ts"),
      "@modeldock/storage": pathOf("./packages/storage/src/index.ts"),
      "@modeldock/tailscale-adapter": pathOf("./packages/tailscale-adapter/src/index.ts"),
      "@modeldock/testing": pathOf("./packages/testing/src/index.ts")
    }
  }
});
