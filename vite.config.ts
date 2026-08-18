import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const collector = process.env.COLLECTOR_ORIGIN ?? "http://127.0.0.1:47123";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "web",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    // Overridable so the UI can be pointed at a second collector — a scratch
    // instance on another port — without editing this file.
    proxy: {
      "/api": collector,
      "/healthz": collector,
      "/readyz": collector,
    },
  },
});
