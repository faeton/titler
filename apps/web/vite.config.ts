import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { Connect, Plugin } from "vite";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev server: tailnet IP so the phone can open it; /api → the Fastify server.
// VITE_MOCK=1 swaps the API for src/api/mock.ts and serves dev-media/ (built by
// scripts/make-dev-media.sh) at /dev-media and /api/fonts.

const HOST = process.env.TITLER_WEB_HOST ?? "100.115.236.50";
const API = process.env.TITLER_API ?? "http://127.0.0.1:8772";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".jpg": "image/jpeg",
  ".ttf": "font/ttf",
  ".json": "application/json",
};

/** Static files with Range support (video seeking needs it). */
const serveDir = (root: string): Connect.NextHandleFunction => (req, res, next) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]!);
  const file = normalize(join(root, url));
  if (!file.startsWith(root)) return next();
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return next();
    size = st.size;
  } catch {
    return next();
  }
  res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (m) {
    const start = m[1] ? Number(m[1]) : size - Number(m[2]);
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", String(size));
    createReadStream(file).pipe(res);
  }
};

const devMedia = (): Plugin => ({
  name: "titler-dev-media",
  configureServer(server) {
    const root = resolve(__dirname, "dev-media");
    server.middlewares.use("/dev-media", serveDir(root));
    server.middlewares.use("/api/fonts", serveDir(join(root, "fonts")));
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const mock = (process.env.VITE_MOCK ?? env.VITE_MOCK) === "1";
  return {
    plugins: [react(), ...(mock ? [devMedia()] : [])],
    server: {
      host: HOST,
      port: 5180,
      strictPort: true,
      proxy: mock ? undefined : { "/api": { target: API, changeOrigin: false } },
    },
    preview: { host: HOST, port: 5180 },
    build: { outDir: "dist", sourcemap: true },
  };
});
