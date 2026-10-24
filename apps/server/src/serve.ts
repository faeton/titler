import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".srt": "application/x-subrip; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".ass": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

export const mimeOf = (path: string): string => MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

/** Parse a single `bytes=` range. null = no/ignored range; "invalid" = 416. */
export const parseRange = (header: string | undefined, size: number): { start: number; end: number } | null | "invalid" => {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or junk: serve the whole file
  const [, a, b] = m;
  let start: number;
  let end: number;
  if (a === "" && b === "") return "invalid";
  if (a === "") {
    const n = Number(b);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
};

export const sendFile = async (
  req: FastifyRequest,
  reply: FastifyReply,
  path: string,
  opts: { downloadName?: string; cache?: string } = {},
): Promise<FastifyReply> => {
  let st;
  try {
    st = await stat(path);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    return reply.code(404).send({ error: "not found" });
  }
  const size = st.size;
  const etag = `"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  reply.header("Accept-Ranges", "bytes").header("Content-Type", mimeOf(path)).header("ETag", etag).header("Last-Modified", st.mtime.toUTCString());
  if (opts.cache) reply.header("Cache-Control", opts.cache);
  if (opts.downloadName) reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(opts.downloadName)}`);
  if (req.headers["if-none-match"] === etag && !req.headers.range) return reply.code(304).send();
  const range = parseRange(req.headers.range, size);
  if (range === "invalid") return reply.code(416).header("Content-Range", `bytes */${size}`).send();
  if (req.method === "HEAD") {
    reply.header("Content-Length", String(range ? range.end - range.start + 1 : size));
    return reply.code(range ? 206 : 200).send();
  }
  if (!range) {
    reply.header("Content-Length", String(size));
    return reply.code(200).send(createReadStream(path));
  }
  reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`).header("Content-Length", String(range.end - range.start + 1));
  return reply.code(206).send(createReadStream(path, { start: range.start, end: range.end }));
};
