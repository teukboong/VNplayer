import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webPort = Number(process.env.VNPLAYER_WEB_PORT ?? 4173);
const backendPort = Number(process.env.VNPLAYER_PORT ?? 4174);

export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    proxy: {
      "/api": `http://127.0.0.1:${backendPort}`,
      "/mcp": `http://127.0.0.1:${backendPort}`
    }
  },
  preview: {
    host: "127.0.0.1",
    port: webPort
  },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true
  }
});
