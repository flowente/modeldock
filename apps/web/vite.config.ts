import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiProxyUrl = process.env.MODELDOCK_WEB_API_PROXY_URL ?? "http://127.0.0.1:4317";
const previewPort = Number(process.env.MODELDOCK_WEB_PREVIEW_PORT ?? "4173");
const devPort = Number(process.env.MODELDOCK_WEB_DEV_PORT ?? "5173");

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    noDiscovery: true,
    include: []
  },
  server: {
    port: devPort,
    proxy: {
      "/api": apiProxyUrl
    }
  },
  preview: {
    port: previewPort,
    proxy: {
      "/api": apiProxyUrl
    }
  }
});
