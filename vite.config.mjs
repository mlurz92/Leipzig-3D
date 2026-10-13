import { defineConfig } from "vite";

/**
 * Leipzig 3D wird als statische Seite ausgeliefert: index.html im Wurzel-
 * verzeichnis, alle Modelldaten, three.js und die Betrachtermodule liegen in
 * public/ und werden unveraendert durchgereicht.
 */
export default defineConfig({
  publicDir: "public",
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,          // Vorschau laeuft ueber einen Proxy-Host
    hmr: false,
    headers: {
      "Cache-Control": "no-store",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
});
