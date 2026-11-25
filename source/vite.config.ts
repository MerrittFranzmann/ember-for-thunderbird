import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Extension pages: relative base, no inline scripts, no modulepreload polyfill,
// everything bundled locally (no remote resources at runtime).
export default defineConfig({
  base: "./",
  plugins: [svelte()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "firefox128",
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      input: { app: "app.html", options: "options.html", settings: "settings.html" },
    },
  },
  test: { include: ["test/**/*.test.ts"] },
});
