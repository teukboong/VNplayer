import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webPort = Number(process.env.VNPLAYER_WEB_PORT ?? 4173);
const webHost = process.env.VNPLAYER_WEB_HOST ?? "127.0.0.1";
const webAllowedHosts = process.env.VNPLAYER_WEB_ALLOWED_HOSTS?.trim();
const backendPort = Number(process.env.VNPLAYER_PORT ?? 4174);

const allowedHosts =
  webAllowedHosts === "all"
    ? true
    : webAllowedHosts
      ? webAllowedHosts
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean)
      : undefined;

export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  server: {
    host: webHost,
    port: webPort,
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    proxy: {
      "/api": `http://127.0.0.1:${backendPort}`,
      "/mcp": `http://127.0.0.1:${backendPort}`
    }
  },
  preview: {
    host: webHost,
    port: webPort
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true
  }
});
