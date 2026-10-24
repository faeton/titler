// Smoke against the real server through the Vite proxy (pnpm dev + apps/server on :8772).
//   node scripts/smoke-server.mjs <clip.mp4> [baseUrl] [outDir]
// Uploads the clip (chunked), waits for ingest + ASR, edits a word (then undoes
// it), checks audio/frame/export on the first project that has a transcript, and
// deletes the uploaded project at the end.
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const clip = process.argv[2];
const base = process.argv[3] ?? process.env.TITLER_WEB_URL ?? "http://127.0.0.1:5180";
const out = process.argv[4] ?? "test-results/server";
mkdirSync(out, { recursive: true });
const fails = [];
const check = (c, m) => (console.log(`${c ? "ok  " : "FAIL"} ${m}`), c || fails.push(m));
const apiGet = (p) => fetch(`${base}/api${p}`).then((r) => r.json());

const browser = await chromium.connect(process.env.PW_WS ?? "ws://127.0.0.1:30150/");
let uploaded = null;
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${base}/#/`);
  await page.locator(".pcard").first().waitFor();
  check(true, "projects listed from server");

  if (clip) {
    const name = `smoke-${Date.now()}-${basename(clip)}`;
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "video/mp4", buffer: readFileSync(clip) });
    await page.waitForURL(/#\/p\/[^/]+\/audio/, { timeout: 60000 });
    uploaded = decodeURIComponent(page.url().split("#/p/")[1].split("/")[0]);
    check(true, `upload → project ${uploaded}`);
    await page.locator("video").waitFor({ timeout: 90000 });
    check(true, "ingest: proxy video appears");
    await page.screenshot({ path: `${out}/1-uploaded.png` });
    await page.getByRole("link", { name: "Текст" }).tap();
    await page.locator(".pm .w").first().waitFor({ timeout: 180000 });
    check(true, "ASR seeded the transcript (shown without reload)");
    await page.screenshot({ path: `${out}/2-uploaded-text.png` });
  }

  const list = await apiGet("/projects");
  const target = list.find((s) => s.hasTranscript && s.project.id !== uploaded) ?? list.find((s) => s.hasTranscript);
  const pid = target.project.id;
  const rev0 = (await apiGet(`/projects/${pid}`)).transcript.rev;
  await page.goto(`${base}/#/p/${pid}/text`);
  await page.locator(".pm .w").first().waitFor();
  const w = page.locator(".pm .w").nth(2);
  await w.tap();
  await page.getByRole("button", { name: "Вставить после" }).tap();
  await page.keyboard.type("проверка");
  await page.waitForFunction((r) => (document.querySelector(".save-state")?.textContent ?? "").match(/Сохранено · правка (\d+)/)?.[1] > r, rev0, { timeout: 15000 });
  const after = (await apiGet(`/projects/${pid}`)).transcript;
  const added = after.doc.paragraphs.flatMap((p) => p.words).find((x) => x.text === "проверка");
  check(!!added && added.source.kind === "user", "edit: inserted word saved on server");
  await page.screenshot({ path: `${out}/3-edit.png` });
  // Undo the insertion (history) and let it save.
  await page.getByRole("button", { name: "Отменить" }).tap();
  await page.getByRole("button", { name: "Готово" }).tap();
  await page.waitForTimeout(2500);
  const reverted = (await apiGet(`/projects/${pid}`)).transcript;
  check(!reverted.doc.paragraphs.flatMap((p) => p.words).some((x) => x.text === "проверка"), "undo: insertion reverted on server");

  await page.getByRole("link", { name: "Звук" }).tap();
  const hasClips = await page.locator(".variants").waitFor({ timeout: 10000 }).then(() => true, () => false);
  check(hasClips, "audio: comparison clips from server");
  if (hasClips) {
    await page.waitForFunction(() => !document.querySelector(".pbar .time")?.textContent?.includes("загрузка"), null, { timeout: 15000 }).catch(() => {});
    check(!(await page.locator(".banner.err").count()), "audio: variants decoded");
  }
  await page.screenshot({ path: `${out}/4-audio.png` });

  await page.getByRole("link", { name: "Кадр" }).tap();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/5-frame.png` });

  await page.getByRole("link", { name: "Экспорт" }).tap();
  await page.locator(".out").first().waitFor({ timeout: 10000 }).catch(() => {});
  const links = await page.locator("a[download]").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  check(links.length > 0, `export: ${links.length} download links`);
  if (links.length) {
    const heads = await Promise.all(links.slice(0, 4).map((h) => fetch(new URL(h, base), { method: "HEAD" }).then((r) => r.status)));
    check(heads.every((s) => s === 200), `export: links resolve (${heads.join(",")})`);
  }
  await page.screenshot({ path: `${out}/6-export.png` });
  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
} finally {
  if (uploaded) await fetch(`${base}/api/projects/${uploaded}`, { method: "DELETE" }).then((r) => console.log("cleanup delete", r.status));
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} failed` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
