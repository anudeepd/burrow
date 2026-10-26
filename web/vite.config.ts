import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_TARGET ?? "http://127.0.0.1:8787";
  return {
    // Browser checks build separately from normal dist so a developer build cannot delete assets under a running test.
    build: { outDir: process.env.BURROW_BUILD_DIR ?? "dist" },
    server: {
      // bind IPv4 loopback explicitly: the dev-mock server proxies non-/api requests to 127.0.0.1:5173, and a default
      // `localhost` binding resolves to ::1 only on some hosts.
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      // The dev-mock proxy cannot forward WebSocket upgrades. Point HMR at Vite's own port so the client connects
      // directly; otherwise Vite's reconnect ping succeeds against the proxy and reloads the page in a loop.
      ws: process.env.BURROW_DEV_MOCK ? { clientPort: 5173 } : undefined,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: false, ws: false },
      },
    },
    resolve: { tsconfigPaths: true },
    plugins: [
      tailwindcss(),
      tanstackStart({ spa: { enabled: true } }),
      // react's vite plugin must come after start's vite plugin
      viteReact(),
    ],
  };
});
