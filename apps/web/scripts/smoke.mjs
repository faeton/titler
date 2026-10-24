// Playwright smoke against the mock dev server (VITE_MOCK=1 pnpm dev).
// Uses the shared Playwright server on n5 (ws://127.0.0.1:30150).
//   node scripts/smoke.mjs [baseUrl] [outDir]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://100.115.236.50:5180";
const out = process.argv[3] ?? "test-results";
const ws = process.env.PW_WS ?? "ws://127.0.0.1:30150/";
mkdirSync(out, { recursive: true });

const fails = [];
const check = (cond, msg) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
  if (!cond) fails.push(msg);
};

const browser = await chromium.connect(ws);
try {
  // ---- phone ----------------------------------------------------------------
  const phone = await browser.newContext({ viewport: { width: 360, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await phone.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource|MEDIA_ERR|NotSupportedError/.test(m.text()) && errors.push(m.text()));

  await page.goto(`${base}/?reset=1#/`);
  await page.getByText("Глинялг, набережная.mov").waitFor();
  await page.screenshot({ path: `${out}/1-projects.png` });
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  check(noHScroll, "projects: no horizontal scroll at 360px");

  await page.getByText("Глинялг, набережная.mov").click();
  await page.locator(".pm .w").first().waitFor();
  check((await page.locator(".pm .w").count()) > 100, "text: words rendered as marked spans");
  check((await page.locator(".pm .w-review").count()) > 0, "text: needs_review words visible");
  check((await page.locator(".pm .w-hidden").count()) > 0, "text: hidden word visible");
  check(await page.evaluate(() => document.querySelector(".pm")?.getAttribute("contenteditable") === "false"), "text: browse mode is not editable");

  // Tap a word → selected + seek, no autoplay.
  const word = page.locator(".pm .w", { hasText: "навигатор" }).first();
  await word.tap();
  await page.locator(".selinfo").waitFor();
  check(await page.locator(".pm .w-sel").count() === 1, "tap: one word selected");
  check((await page.locator(".selinfo").innerText()).includes("навигатор"), "tap: action panel shows the word");
  const playing = await page.evaluate(() => { const v = document.querySelector("video"); return v ? !v.paused : false; });
  check(!playing, "tap: no autoplay");
  await page.screenshot({ path: `${out}/2-text-selected.png` });

  // Insert after → edit mode, type, autosave stamps an id.
  await page.getByRole("button", { name: "Вставить после" }).tap();
  check(await page.evaluate(() => document.querySelector(".pm")?.getAttribute("contenteditable") === "true"), "insert: edit mode on");
  await page.keyboard.type("новенький");
  await page.screenshot({ path: `${out}/3-text-editing.png` });
  await page.waitForFunction(() => document.querySelector(".save-state")?.textContent?.startsWith("Сохранено") && document.querySelector(".save-state")?.textContent?.includes("правка 2"), null, { timeout: 8000 });
  check(true, "insert: saved as revision 2");
  const stamped = await page.evaluate(() => [...document.querySelectorAll(".pm [data-w]")].some((e) => e.textContent === "новенький"));
  check(stamped, "insert: typed word got a server id");
  await page.getByRole("button", { name: "Готово" }).tap();
  // Aligner (mock) writes revision 3 → adopted silently.
  await page.waitForFunction(() => document.querySelector(".save-state")?.textContent?.includes("правка 3"), null, { timeout: 8000 });
  check(true, "align: polled revision adopted without conflict");

  // Long press → range, hide from subtitles.
  const w1 = page.locator(".pm .w", { hasText: "Кстати," }).first();
  const box = await w1.boundingBox();
  await page.touchscreen.tap(box.x + 2, box.y + 2); // ensure not editing
  await w1.dispatchEvent("pointerdown", { pointerType: "touch", clientX: box.x + 5, clientY: box.y + 5 });
  await page.waitForTimeout(600);
  await w1.dispatchEvent("pointerup");
  await page.locator(".pm .w", { hasText: "хорошее" }).first().tap();
  check(await page.locator(".pm .w-sel").count() >= 2, "long-press: range selection");
  await page.getByRole("button", { name: "Убрать из субтитров" }).tap();
  await page.waitForFunction(() => document.querySelectorAll(".pm .w-hidden").length >= 3, null, { timeout: 5000 });
  check(true, "range: hidden via ops");
  await page.screenshot({ path: `${out}/4-text-range.png` });

  // Frame tab
  await page.getByRole("link", { name: "Кадр" }).tap();
  await page.getByRole("button", { name: "Плашка" }).tap();
  await page.getByRole("button", { name: "Сдвинуть кадр" }).tap();
  await page.locator(".cropwin").waitFor();
  await page.screenshot({ path: `${out}/5-frame-crop.png` });
  await page.getByRole("button", { name: "Готово" }).tap();
  await page.evaluate(() => { const v = document.querySelector("video"); if (v) v.currentTime = 12; });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/6-frame-preview.png` });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "frame: no horizontal scroll");

  // Audio tab
  await page.getByRole("link", { name: "Звук" }).tap();
  await page.locator(".variants").waitFor();
  await page.getByRole("button", { name: /C\s*Голос/ }).tap();
  await page.screenshot({ path: `${out}/7-audio.png` });

  // Export tab
  await page.getByRole("link", { name: "Экспорт" }).tap();
  await page.getByRole("button", { name: "Экспортировать" }).tap();
  await page.getByText("Скачать").first().waitFor({ timeout: 12000 });
  check((await page.locator("a[download]").count()) >= 2, "export: download links listed");
  await page.screenshot({ path: `${out}/8-export.png` });

  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);

  // ---- desktop, dark ---------------------------------------------------------
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  const dp = await desk.newPage();
  await dp.goto(`${base}/#/p/demo/text`);
  await dp.locator(".pm .w").first().waitFor();
  await dp.locator(".pm .w").nth(5).click();
  await dp.keyboard.press("ArrowRight");
  await dp.keyboard.press("Shift+ArrowRight");
  check(await dp.locator(".pm .w-sel").count() === 2, "desktop: arrows + shift select a range");
  await dp.screenshot({ path: `${out}/9-desktop-dark.png` });
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} check(s) failed` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
