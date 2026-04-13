import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The studio dev server proxies API calls to the local Fastify server
// on :7777 so we can use EventSource / fetch without CORS pain.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7777",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
