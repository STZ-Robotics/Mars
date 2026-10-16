import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "../../desktop/src");

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Ares looks and works like MARS Desktop because it IS MARS Desktop's UI:
// `@desktop` points at its sources (panels, property rows, the 3D scene kit,
// the model loader) instead of a copy that would drift. `dedupe` makes the
// files imported from there use THIS app's react and three, not a second
// instance from desktop/node_modules.
export default defineConfig(async () => ({
  plugins: [react()],
  // The field images and their calibration JSON are MARS Desktop's too.
  publicDir: path.resolve(desktop, "../public"),
  resolve: {
    alias: { "@desktop": desktop },
    dedupe: ["react", "react-dom", "three", "@tauri-apps/api", "@tauri-apps/plugin-dialog"],
  },
  clearScreen: false,
  server: {
    // MARS Desktop owns 1420; both can run at once.
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    fs: { allow: [here, desktop] },
  },
}));
