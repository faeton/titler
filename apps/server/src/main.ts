import { buildApp } from "./app.js";

const app = await buildApp();
const { host, port } = app.ctx.cfg;
app.ctx.log.info(
  { dataDir: app.ctx.cfg.dataDir, hwEncoder: app.ctx.cfg.ffmpegHw !== null ? app.ctx.cfg.hwEncoder : null, ffmpeg: app.ctx.cfg.ffmpeg },
  "titler server starting",
);

let closing = false;
const shutdown = async (sig: string) => {
  if (closing) return;
  closing = true;
  app.ctx.log.info({ sig }, "shutting down");
  await app.close().catch((e) => app.ctx.log.error(e));
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.fastify.listen({ host, port });
