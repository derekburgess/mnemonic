import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: `http://127.0.0.1:${process.env.PORT ?? loadEnv(mode, process.cwd(), "").PORT ?? 8787}`, changeOrigin: true },
    },
  },
}));
