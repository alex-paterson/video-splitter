import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/events": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
      "/run": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
