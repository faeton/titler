import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { rmDir, testApp, tmpDir } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const SECRET = "gw-secret-for-tests";
const GW = { "x-titler-gateway": SECRET, "x-forwarded-for": "203.0.113.7", "x-forwarded-proto": "https" };

const start = async (auth: Partial<App["ctx"]["cfg"]["auth"]> = {}) => {
  const dir = tmpDir();
  const app = await testApp(dir, { noScheduler: true, config: { ffmpegHw: null, auth: { mode: "gateway", gatewaySecret: SECRET, corsOrigins: ["https://app.example"], sessionDays: 30, ...auth } } });
  cleanups.push(() => rmDir(dir));
  cleanups.push(() => app.close());
  return app;
};

const call = async (app: App, method: string, url: string, o: { headers?: Record<string, string>; body?: unknown } = {}) => {
  const res = await app.fastify.inject({ method: method as "GET", url, headers: o.headers, ...(o.body !== undefined ? { payload: o.body as object } : {}) });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* not json */
  }
  return { status: res.statusCode, json: json as Record<string, any> | null, res };
};

describe("access control", () => {
  it("tailnet / local requests stay open; gateway requests must log in", async () => {
    const app = await start();
    expect((await call(app, "GET", "/api/projects")).status).toBe(200);
    expect((await call(app, "GET", "/api/auth/me")).json).toMatchObject({ required: false, authenticated: true, via: "local" });
    expect((await call(app, "GET", "/api/projects", { headers: GW })).status).toBe(401);
    expect((await call(app, "GET", "/api/auth/me", { headers: GW })).json).toMatchObject({ required: true, authenticated: false });
    expect((await call(app, "GET", "/api/health", { headers: GW })).status).toBe(200);
    // A gateway header with the wrong secret is refused outright.
    expect((await call(app, "GET", "/api/health", { headers: { "x-titler-gateway": "nope" } })).status).toBe(401);
  });

  it("owner token → session cookie; device keys are hashed, scoped and revocable", async () => {
    const app = await start();
    const { secret: owner } = app.ctx.auth.createKey("owner", "me");
    expect((await call(app, "POST", "/api/auth/login", { headers: GW, body: { token: "to_wrong" } })).status).toBe(401);
    const login = await call(app, "POST", "/api/auth/login", { headers: GW, body: { token: owner } });
    expect(login.status).toBe(200);
    const setCookie = String(login.res.headers["set-cookie"]);
    expect(setCookie).toMatch(/^titler_session=[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    const cookie = setCookie.split(";")[0]!;
    const S = { ...GW, cookie };
    expect((await call(app, "GET", "/api/projects", { headers: S })).status).toBe(200);
    expect((await call(app, "GET", "/api/auth/me", { headers: S })).json).toMatchObject({ authenticated: true, via: "session", name: "me" });

    const made = await call(app, "POST", "/api/auth/keys", { headers: S, body: { name: "iPhone" } });
    expect(made.status).toBe(200);
    const devKey = made.json!.secret as string;
    expect(devKey).toMatch(/^tk_/);
    const D = { ...GW, authorization: `Bearer ${devKey}` };
    expect((await call(app, "GET", "/api/projects", { headers: D })).status).toBe(200);
    // Plain-http access (dev, TITLER_AUTH=all) gets a cookie the browser will keep.
    const plain = await call(app, "POST", "/api/auth/login", { headers: { ...GW, "x-forwarded-proto": "http" }, body: { token: owner } });
    expect(String(plain.res.headers["set-cookie"])).not.toContain("Secure");
    // Device keys can't manage keys, and can't log in as owner.
    expect((await call(app, "GET", "/api/auth/keys", { headers: D })).status).toBe(403);
    expect((await call(app, "POST", "/api/auth/login", { headers: GW, body: { token: devKey } })).status).toBe(401);
    const list = (await call(app, "GET", "/api/auth/keys", { headers: S })).json as unknown as { id: string; name: string; lastUsedAt: string | null }[];
    expect(list.map((k) => k.name).sort()).toEqual(["iPhone", "me"]);
    expect(JSON.stringify(list)).not.toContain(devKey);
    expect(list.find((k) => k.name === "iPhone")!.lastUsedAt).toBeTruthy();

    expect((await call(app, "DELETE", `/api/auth/keys/${made.json!.id}`, { headers: S })).json).toMatchObject({ revokedAt: expect.any(String) });
    expect((await call(app, "GET", "/api/projects", { headers: D })).status).toBe(401);
    // Revoking the owner key ends its sessions.
    app.ctx.auth.revokeKey(list.find((k) => k.name === "me")!.id);
    expect((await call(app, "GET", "/api/projects", { headers: S })).status).toBe(401);
    expect((await call(app, "POST", "/api/auth/logout", { headers: S })).res.headers["set-cookie"]).toMatch(/Max-Age=0/);
  });

  it("TITLER_AUTH=all asks everyone; off asks no one", async () => {
    const all = await start({ mode: "all" });
    expect((await call(all, "GET", "/api/projects")).status).toBe(401);
    expect((await call(all, "GET", "/")).status).not.toBe(401); // SPA shell (shows the login screen)
    const off = await start({ mode: "off" });
    expect((await call(off, "GET", "/api/projects", { headers: GW })).status).toBe(200);
  });

  it("signed links: one file, expiring, tamper-proof, Range", async () => {
    const app = await start();
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    // A project + artifact row pointing at a real file.
    const p = app.ctx.store.createProject({ name: "x", sourceSha256: "s", sourceName: "x.mov", sourcePath: "sources/x.mov" });
    mkdirSync(join(app.ctx.cfg.dataDir, "artifacts/k1"), { recursive: true });
    writeFileSync(join(app.ctx.cfg.dataDir, "artifacts/k1/v.mp4"), Buffer.from("0123456789"));
    writeFileSync(join(app.ctx.cfg.dataDir, "artifacts/k1/c.jpg"), Buffer.from("jpeg"));
    app.ctx.store.putArtifact({ key: "k1", projectId: p.id, kind: "render", path: "artifacts/k1/v.mp4", meta: {} });

    expect((await call(app, "POST", "/api/artifacts/k1/sign", { headers: GW, body: {} })).status).toBe(401);
    expect((await call(app, "POST", "/api/artifacts/k1/sign", { body: { ttlSec: 5 } })).status).toBe(400);
    const s = await call(app, "POST", "/api/artifacts/k1/sign", { body: { ttlSec: 600 } });
    const url = s.json!.url as string;
    expect(url).toMatch(/^\/s\/[\w-]+\.[\w-]+\/v\.mp4$/);
    // Public through the gateway, with Range.
    const got = await call(app, "GET", url, { headers: { ...GW, range: "bytes=2-4" } });
    expect(got.status).toBe(206);
    expect(got.res.body).toBe("234");
    // The token covers one file: swapping the name doesn't reach siblings.
    expect((await call(app, "GET", url.replace(/v\.mp4$/, "c.jpg"), { headers: GW })).res.body).toBe("0123456789");
    const cover = (await call(app, "POST", "/api/artifacts/k1/sign", { body: { file: "c.jpg" } })).json!.url as string;
    expect((await call(app, "GET", cover, { headers: GW })).res.body).toBe("jpeg");
    const token = url.split("/")[2]!;
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ k: "k1", f: "c.jpg", e: 9e9 })).toString("base64url");
    expect((await call(app, "GET", `/s/${forged}.${mac}`, { headers: GW })).status).toBe(403);
    const flipped = (mac![0] === "A" ? "B" : "A") + mac!.slice(1);
    expect((await call(app, "GET", `/s/${payload}.${flipped}`, { headers: GW })).status).toBe(403);
    const old = app.ctx.auth.sign("k1", "v.mp4", -10).token;
    expect((await call(app, "GET", `/s/${old}`, { headers: GW })).status).toBe(410);
  });

  it("rotating the signing secret invalidates every signed link; owner only", async () => {
    const app = await start();
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const p = app.ctx.store.createProject({ name: "x", sourceSha256: "s", sourceName: "x.mov", sourcePath: "sources/x.mov" });
    mkdirSync(join(app.ctx.cfg.dataDir, "artifacts/k1"), { recursive: true });
    writeFileSync(join(app.ctx.cfg.dataDir, "artifacts/k1/v.mp4"), Buffer.from("0123456789"));
    app.ctx.store.putArtifact({ key: "k1", projectId: p.id, kind: "render", path: "artifacts/k1/v.mp4", meta: {} });

    expect((await call(app, "GET", "/api/auth/links")).json).toEqual({ issued: 0, rotatedAt: null, lastExpiresAt: null });
    const a = (await call(app, "POST", "/api/artifacts/k1/sign", { body: { ttlSec: 600 } })).json!;
    const b = (await call(app, "POST", "/api/artifacts/k1/sign", { body: { ttlSec: 7200 } })).json!;
    expect((await call(app, "GET", "/api/auth/links")).json).toEqual({ issued: 2, rotatedAt: null, lastExpiresAt: b.expiresAt });
    expect((await call(app, "GET", a.url, { headers: GW })).status).toBe(200);

    // Through the gateway only an owner session may rotate; a device key may not.
    const { secret: dev } = app.ctx.auth.createKey("device", "script");
    expect((await call(app, "POST", "/api/auth/links/rotate", { headers: GW })).status).toBe(401);
    expect((await call(app, "POST", "/api/auth/links/rotate", { headers: { ...GW, authorization: `Bearer ${dev}` } })).status).toBe(403);
    const { secret: owner } = app.ctx.auth.createKey("owner", "me");
    const cookie = String((await call(app, "POST", "/api/auth/login", { headers: GW, body: { token: owner } })).res.headers["set-cookie"]).split(";")[0]!;
    const r = await call(app, "POST", "/api/auth/links/rotate", { headers: { ...GW, cookie } });
    expect(r.json).toEqual({ issued: 0, rotatedAt: expect.any(String), lastExpiresAt: null });
    for (const u of [a.url, b.url]) expect((await call(app, "GET", u, { headers: GW })).status).toBe(403);
    // New links work, and the secret survives a restart (same DB).
    const c = (await call(app, "POST", "/api/artifacts/k1/sign", { body: {} })).json!;
    expect((await call(app, "GET", c.url, { headers: GW })).status).toBe(200);
    const { Auth } = await import("../src/auth.js");
    const again = new Auth((app.ctx.auth as unknown as { db: never }).db, app.ctx.auth.cfg);
    expect(again.verify(c.url.split("/")[2]!)).toEqual({ key: "k1", file: "v.mp4" });
    expect(again.linkStats().issued).toBe(1);
  });

  it("CORS for listed origins only; login is rate limited per client", async () => {
    const app = await start();
    const pre = await call(app, "OPTIONS", "/api/projects", { headers: { origin: "https://app.example", "access-control-request-method": "GET" } });
    expect(pre.status).toBe(204);
    expect(pre.res.headers["access-control-allow-origin"]).toBe("https://app.example");
    expect(pre.res.headers["access-control-allow-credentials"]).toBe("true");
    const other = await call(app, "GET", "/api/health", { headers: { origin: "https://evil.example" } });
    expect(other.res.headers["access-control-allow-origin"]).toBeUndefined();

    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await call(app, "POST", "/api/auth/login", { headers: GW, body: { token: "to_x" } })).status);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    // Another client is unaffected.
    expect((await call(app, "POST", "/api/auth/login", { headers: { ...GW, "x-forwarded-for": "198.51.100.1" }, body: { token: "to_x" } })).status).toBe(401);
  });
});

// ---- passkeys: a software authenticator (P-256, "none" attestation) drives the real verification ----

/** Just enough CBOR for WebAuthn: small ints, byte and text strings, maps. */
const cbor = (v: unknown): Buffer => {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor: unsupported");
};

const softAuthenticator = (rpId: string, origin: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = randomBytes(16);
  const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
  const rpHash = sha(rpId);
  const clientData = (type: string, challenge: string, o = origin) => Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
  const id = credId.toString("base64url");
  let counter = 0;
  return {
    id,
    create: (challenge: string) => {
      const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]));
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credId.length);
      // flags UP | UV | AT, counter 0, zero AAGUID
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cose]);
      const att = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: clientData("webauthn.create", challenge).toString("base64url"), attestationObject: att.toString("base64url"), transports: ["internal"] },
      };
    },
    get: (challenge: string, o?: string) => {
      const cnt = Buffer.alloc(4);
      cnt.writeUInt32BE(++counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), cnt]); // UP | UV
      const cd = clientData("webauthn.get", challenge, o);
      const signature = sign("sha256", Buffer.concat([authData, sha(cd)]), privateKey); // DER, as authenticators send it
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: { clientDataJSON: cd.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") },
      };
    },
  };
};

describe("passkeys", () => {
  const ORIGIN = "https://titler.example";
  // Passkey logins count against the login rate limit: use their own client address.
  const GWP = { ...GW, "x-forwarded-for": "198.51.100.9" };

  it("are off without TITLER_PUBLIC_ORIGIN, and say why", async () => {
    const app = await start();
    expect((await call(app, "GET", "/api/auth/passkey", { headers: GW })).json).toEqual({ enabled: false, reason: "TITLER_PUBLIC_ORIGIN is not set" });
    expect((await call(app, "POST", "/api/auth/passkey/login/options", { headers: GW, body: {} })).status).toBe(400);
    const http = await start({ publicOrigin: "http://titler.example" });
    expect((await call(http, "GET", "/api/auth/passkey")).json).toMatchObject({ enabled: false, reason: "TITLER_PUBLIC_ORIGIN must be https" });
  });

  it("register from an owner session, log in to the same session cookie, revoke", async () => {
    const app = await start({ publicOrigin: ORIGIN });
    expect((await call(app, "GET", "/api/auth/passkey", { headers: GW })).json).toEqual({ enabled: true, origin: ORIGIN, rpId: "titler.example" });
    const { secret: owner } = app.ctx.auth.createKey("owner", "me");
    const cookie = String((await call(app, "POST", "/api/auth/login", { headers: GW, body: { token: owner } })).res.headers["set-cookie"]).split(";")[0]!;
    const S = { ...GW, cookie };
    const dev = app.ctx.auth.createKey("device", "script").secret;

    // Registration: owner only.
    expect((await call(app, "POST", "/api/auth/passkey/register/options", { headers: GW, body: {} })).status).toBe(401);
    expect((await call(app, "POST", "/api/auth/passkey/register/options", { headers: { ...GW, authorization: `Bearer ${dev}` }, body: {} })).status).toBe(403);
    const ro = (await call(app, "POST", "/api/auth/passkey/register/options", { headers: S, body: {} })).json!;
    expect(ro.rp).toEqual({ name: "Titler", id: "titler.example" });
    expect(ro.authenticatorSelection).toMatchObject({ residentKey: "required" });
    const authr = softAuthenticator("titler.example", ORIGIN);
    const reg = await call(app, "POST", "/api/auth/passkey/register/verify", { headers: S, body: { name: "iPhone", response: authr.create(ro.challenge) } });
    expect(reg.status).toBe(200);
    expect(reg.json).toMatchObject({ kind: "passkey", name: "iPhone", revokedAt: null });
    // The challenge is single-use; the same credential can't be added twice.
    expect((await call(app, "POST", "/api/auth/passkey/register/verify", { headers: S, body: { response: authr.create(ro.challenge) } })).status).toBe(400);
    const ro2 = (await call(app, "POST", "/api/auth/passkey/register/options", { headers: S, body: {} })).json!;
    expect(ro2.excludeCredentials).toEqual([{ id: authr.id, type: "public-key", transports: ["internal"] }]);
    expect((await call(app, "POST", "/api/auth/passkey/register/verify", { headers: S, body: { response: authr.create(ro2.challenge) } })).status).toBe(409);

    // Login through the gateway without any credential.
    const lo = (await call(app, "POST", "/api/auth/passkey/login/options", { headers: GWP, body: {} })).json!;
    expect(lo.rpId).toBe("titler.example");
    const login = await call(app, "POST", "/api/auth/passkey/login/verify", { headers: GWP, body: { response: authr.get(lo.challenge) } });
    expect(login.status).toBe(200);
    expect(login.json).toMatchObject({ ok: true, name: "iPhone" });
    const setCookie = String(login.res.headers["set-cookie"]);
    expect(setCookie).toMatch(/^titler_session=[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
    const P = { ...GW, cookie: setCookie.split(";")[0]! };
    expect((await call(app, "GET", "/api/auth/me", { headers: P })).json).toMatchObject({ authenticated: true, via: "session", name: "iPhone" });
    expect((await call(app, "GET", "/api/auth/keys", { headers: P })).status).toBe(200); // owner rights

    // Replayed challenge, wrong origin, unknown credential → refused.
    expect((await call(app, "POST", "/api/auth/passkey/login/verify", { headers: GWP, body: { response: authr.get(lo.challenge) } })).status).toBe(401);
    const lo2 = (await call(app, "POST", "/api/auth/passkey/login/options", { headers: GWP, body: {} })).json!;
    expect((await call(app, "POST", "/api/auth/passkey/login/verify", { headers: GWP, body: { response: authr.get(lo2.challenge, "https://evil.example") } })).status).toBe(401);
    const other = softAuthenticator("titler.example", ORIGIN);
    const lo3 = (await call(app, "POST", "/api/auth/passkey/login/options", { headers: GWP, body: {} })).json!;
    expect((await call(app, "POST", "/api/auth/passkey/login/verify", { headers: GWP, body: { response: other.get(lo3.challenge) } })).json).toMatchObject({ error: "unknown passkey" });

    // Revoking its key row (same list as device keys) ends its sessions and disables it.
    expect((await call(app, "DELETE", `/api/auth/keys/${reg.json!.id}`, { headers: S })).status).toBe(200);
    expect((await call(app, "GET", "/api/projects", { headers: P })).status).toBe(401);
    const lo4 = (await call(app, "POST", "/api/auth/passkey/login/options", { headers: GWP, body: {} })).json!;
    expect((await call(app, "POST", "/api/auth/passkey/login/verify", { headers: GWP, body: { response: authr.get(lo4.challenge) } })).status).toBe(401);
  });
});
