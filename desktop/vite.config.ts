import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import publicEnv from "./public-env.json";

const host = process.env.TAURI_DEV_HOST;

// The shared ../app code reads public addresses from process.env.NEXT_PUBLIC_* (the site's Vercel env). Vite would turn
// process.env into {}, so the app silently used the built-in fallbacks. Bake the same public values in from
// desktop/public-env.json (committed: public addresses only, no secrets), overridable from the build environment.
export default defineConfig(({ mode }) => ({
  define: {
    "process.env": JSON.stringify({ ...publicEnv, ...loadEnv(mode, __dirname, "NEXT_PUBLIC_"), ...pickPublic(process.env) }),
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@delphi": path.resolve(__dirname, "../app"),
      viem: path.resolve(__dirname, "node_modules/viem"),
      // shared ../app/lib/inference code: resolve its crypto libraries from this app (same audited versions viem uses)
      "@noble/curves": path.resolve(__dirname, "node_modules/@noble/curves"),
      "@noble/hashes": path.resolve(__dirname, "node_modules/@noble/hashes"),
      "@noble/ciphers": path.resolve(__dirname, "node_modules/@noble/ciphers"),
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

function pickPublic(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => k.startsWith("NEXT_PUBLIC_") && v)) as Record<string, string>;
}
