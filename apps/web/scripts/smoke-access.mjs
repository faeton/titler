// Login + device keys through the "public gateway", headless mobile Chromium.
//   GATEWAY_SECRET=… OWNER_TOKEN=to_… node scripts/smoke-access.mjs <serverUrl> [outDir]
// The server must run with TITLER_GATEWAY_SECRET=<same secret>; the browser sends the
// gateway header the way Caddy on de1 does. Use a scratch TITLER_DATA: the run
// creates and revokes a device key and logs in/out.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? process.env.TITLER_WEB_URL ?? "http://127.0.0.1:8772";
const out = process.argv[3] ?? "test-results/access";
const secret = process.env.GATEWAY_SECRET;
const owner = process.env.OWNER_TOKEN;
if (!secret || !owner) throw new Error("set GATEWAY_SECRET and OWNER_TOKEN");
mkdirSync(out, { recursive: true });
const fails = [];
const check = (c, m) => (console.log(`${c ? "ok  " : "FAIL"} ${m}`), c || fails.push(m));

const browser = await chromium.connect(process.env.PW_WS ?? "ws://127.0.0.1:30150/");
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, extraHTTPHeaders: { "x-titler-gateway": secret } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${base}/#/`);
  await page.getByRole("heading", { name: "Вход" }).waitFor({ timeout: 10000 });
  check(true, "gateway visitor sees the login screen");
  await page.locator("input[type=password]").fill("to_wrong");
  await page.getByRole("button", { name: "Войти" }).tap();
  await page.locator(".banner.err").waitFor();
  check((await page.locator(".banner.err").textContent())?.includes("Неверный"), "wrong token is refused");
  await page.locator("input[type=password]").fill(owner);
  await page.getByRole("button", { name: "Войти" }).tap();
  await page.locator(".upload-cta").waitFor({ timeout: 10000 });
  check(true, "owner token → project list");
  const cookies = await ctx.cookies();
  const c = cookies.find((x) => x.name === "titler_session");
  // Secure only over HTTPS (Caddy sends X-Forwarded-Proto: https); this smoke may run on plain http.
  check(!!c && c.httpOnly && c.secure === base.startsWith("https:"), `session cookie HttpOnly${c?.secure ? " + Secure" : ""}`);

  await page.getByRole("link", { name: "Доступ" }).tap();
  await page.getByRole("heading", { name: "Ключи устройств" }).waitFor();
  await page.locator("input.text").fill("smoke phone");
  await page.getByRole("button", { name: "Создать" }).tap();
  await page.locator(".secret code").waitFor();
  const key = await page.locator(".secret code").textContent();
  check(/^tk_/.test(key ?? ""), "device key shown once");
  const withKey = await fetch(`${base}/api/projects`, { headers: { "x-titler-gateway": secret, authorization: `Bearer ${key}` } });
  check(withKey.status === 200, `device key works (${withKey.status})`);
  await page.screenshot({ path: `${out}/1-keys.png` });
  page.once("dialog", (d) => d.accept());
  await page.locator(".out", { hasText: "smoke phone" }).getByRole("button", { name: "Отозвать" }).tap();
  await page.locator(".out", { hasText: "отозван" }).waitFor();
  const revoked = await fetch(`${base}/api/projects`, { headers: { "x-titler-gateway": secret, authorization: `Bearer ${key}` } });
  check(revoked.status === 401, `revoked key refused (${revoked.status})`);

  await page.getByRole("button", { name: "Выйти" }).tap();
  await page.getByRole("heading", { name: "Вход" }).waitFor({ timeout: 10000 });
  check(true, "logout → login screen");
  check(errors.length === 0, `no page errors ${errors.join(" | ")}`);
} finally {
  await browser.close();
}
console.log(fails.length ? `\n${fails.length} failed` : "\nall checks passed");
process.exit(fails.length ? 1 : 0);
