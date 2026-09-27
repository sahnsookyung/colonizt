import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8787";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: Object.fromEntries(["/config", "/sessions", "/ws-tickets", "/rooms", "/matches", "/analytics", "/ws"].map((path) => [path, {
      target, ws: path === "/ws", changeOrigin: false, xfwd: true,
    }])),
  },
});
