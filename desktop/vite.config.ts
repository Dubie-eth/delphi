import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error TAURI_DEV_HOST from tauri
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@delphi": path.resolve(__dirname, "../app"),
      viem: path.resolve(__dirname, "node_modules/viem"),
    },
    // shared ../app files resolve react from this app's node_modules (the public repo has no site node_modules)
    dedupe: ["react", "react-dom"],
  },
  css: {
    postcss: { plugins: [] },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
