import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { tx, type Db } from "./db.js";
import { newId, now } from "./store.js";

// Access control for the public gateway (PLAN-v3 §2, step A).
//
// The server still only listens on localhost / the tailnet. A gateway (Caddy
// on de1) proxies internet traffic to it and adds `X-Titler-Gateway: <secret>`
// (stripping any client-supplied copy). Requests carrying the header must
// authenticate; requests without it come from this box or the tailnet and stay
// open, unless TITLER_AUTH=all. Credentials:
//   - owner token  → POST /api/auth/login → session cookie (HttpOnly; Secure over HTTPS)
//   - device keys  → Authorization: Bearer tk_…  (named, hashed, revocable)
//   - passkeys     → WebAuthn (passkeys.ts) → the same session cookie
//   - signed links → /s/<token> for one artifact file until it expires
//                    (Instagram / AudioShake / Modal fetch media by URL);
//                    rotating the signing secret invalidates all of them at once

export type AuthMode = "gateway" | "all" | "off";

export interface AuthConfig {
  mode: AuthMode;
  /** Shared with the gateway; null = no gateway configured (header is then always rejected). */
  gatewaySecret: string | null;
  corsOrigins: string[];
  sessionDays: number;
  publicOrigin?: string | null;
}

export interface KeyRow {
  id: string;
  /** owner: token that logs in; device: Bearer key; passkey: a WebAuthn credential's identity. */
  kind: "owner" | "device" | "passkey";
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Signed links issued with the current signing secret (no per-link rows: counters in settings_kv). */
export interface LinkStats {
  issued: number;
  /** When the secret was last rotated; null = never (the secret from first start). */
  rotatedAt: string | null;
  /** Latest expiry among those links; null = none issued. Past it, nothing signed is still valid. */
  lastExpiresAt: string | null;
}

export const hashSecret = (s: string): string => createHash("sha256").update(s).digest("hex");

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

const safeEq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

type Row = Record<string, unknown>;
const toKey = (r: Row): KeyRow => ({
  id: r.id as string,
  kind: r.kind as KeyRow["kind"],
  name: r.name as string,
  createdAt: r.created_at as string,
  lastUsedAt: (r.last_used_at as string | null) ?? null,
  revokedAt: (r.revoked_at as string | null) ?? null,
});

export class Auth {
  private signingKey: Buffer;

  constructor(
    private db: Db,
    readonly cfg: AuthConfig,
  ) {
    const v = this.kv("signing_secret");
    if (v) this.signingKey = Buffer.from(v, "hex");
    else {
      this.signingKey = randomBytes(32);
      this.setKv("signing_secret", this.signingKey.toString("hex"));
    }
  }

  private kv(k: string): string | null {
    const r = this.db.prepare("SELECT v FROM settings_kv WHERE k = ?").get(k) as Row | undefined;
    return r ? (r.v as string) : null;
  }

  private setKv(k: string, v: string): void {
    this.db.prepare("INSERT INTO settings_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  // ---- keys ----
  /** New owner token or device key; the secret is returned once and only its hash is stored. */
  createKey(kind: KeyRow["kind"], name: string): { key: KeyRow; secret: string } {
    // A passkey's row gets a random secret too (the hash column is unique), but it is never shown.
    const secret = `${{ owner: "to", device: "tk", passkey: "pk" }[kind]}_${randomBytes(24).toString("base64url")}`;
    const id = newId();
    this.db.prepare("INSERT INTO auth_keys (id, kind, name, hash, created_at) VALUES (?,?,?,?,?)").run(id, kind, name, hashSecret(secret), now());
    return { key: this.getKey(id)!, secret };
  }

  getKey(id: string): KeyRow | null {
    const r = this.db.prepare("SELECT * FROM auth_keys WHERE id = ?").get(id) as Row | undefined;
    return r ? toKey(r) : null;
  }

  listKeys(): KeyRow[] {
    return (this.db.prepare("SELECT * FROM auth_keys ORDER BY created_at DESC").all() as Row[]).map(toKey);
  }

  revokeKey(id: string): boolean {
    const res = this.db.prepare("UPDATE auth_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id);
    this.db.prepare("DELETE FROM sessions WHERE key_id = ?").run(id);
    return Number(res.changes) === 1;
  }

  /** Active key for a presented secret, touching last_used_at. */
  private findActive(secret: string, kind?: KeyRow["kind"]): KeyRow | null {
    const r = this.db.prepare("SELECT * FROM auth_keys WHERE hash = ? AND revoked_at IS NULL").get(hashSecret(secret)) as Row | undefined;
    if (!r || (kind && r.kind !== kind)) return null;
    this.db.prepare("UPDATE auth_keys SET last_used_at = ? WHERE id = ?").run(now(), r.id as string);
    return toKey(r);
  }

  // ---- sessions ----
  login(ownerToken: string): { cookie: string; expiresAt: string; key: KeyRow } | null {
    const key = this.findActive(ownerToken, "owner");
    return key ? this.startSession(key) : null;
  }

  /** A session for an already verified key (owner token or passkey). */
  startSession(key: KeyRow): { cookie: string; expiresAt: string; key: KeyRow } {
    const cookie = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.cfg.sessionDays * 86_400_000).toISOString();
    this.db.prepare("INSERT INTO sessions (hash, key_id, created_at, expires_at) VALUES (?,?,?,?)").run(hashSecret(cookie), key.id, now(), expiresAt);
    return { cookie, expiresAt, key };
  }

  logout(cookie: string): void {
    this.db.prepare("DELETE FROM sessions WHERE hash = ?").run(hashSecret(cookie));
  }

  private session(cookie: string): KeyRow | null {
    const r = this.db
      .prepare("SELECT k.* FROM sessions s JOIN auth_keys k ON k.id = s.key_id WHERE s.hash = ? AND s.expires_at > ? AND k.revoked_at IS NULL")
      .get(hashSecret(cookie), now()) as Row | undefined;
    return r ? toKey(r) : null;
  }

  // ---- signed links ----
  sign(artifactKey: string, file: string, ttlSec: number): { token: string; expiresAt: string } {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const payload = b64url(JSON.stringify({ k: artifactKey, f: file, e: exp }));
    const mac = createHmac("sha256", this.signingKey).update(payload).digest("base64url");
    const expiresAt = new Date(exp * 1000).toISOString();
    this.setKv("signing_issued", String(Number(this.kv("signing_issued") ?? 0) + 1));
    const last = this.kv("signing_last_exp");
    if (!last || last < expiresAt) this.setKv("signing_last_exp", expiresAt);
    return { token: `${payload}.${mac}`, expiresAt };
  }

  linkStats(): LinkStats {
    return { issued: Number(this.kv("signing_issued") ?? 0), rotatedAt: this.kv("signing_rotated_at"), lastExpiresAt: this.kv("signing_last_exp") };
  }

  /** New signing secret: every link signed so far stops working (403). */
  rotateSigningKey(): LinkStats {
    this.signingKey = randomBytes(32);
    tx(this.db, () => {
      this.setKv("signing_secret", this.signingKey.toString("hex"));
      this.setKv("signing_rotated_at", now());
      this.setKv("signing_issued", "0");
      this.db.prepare("DELETE FROM settings_kv WHERE k = 'signing_last_exp'").run();
    });
    return this.linkStats();
  }

  /** "bad" = forged / malformed, "expired" = valid but past its time. */
  verify(token: string): { key: string; file: string } | "bad" | "expired" {
    const [payload, mac] = token.split(".");
    if (!payload || !mac) return "bad";
    const want = createHmac("sha256", this.signingKey).update(payload).digest("base64url");
    if (!safeEq(mac, want)) return "bad";
    try {
      const o = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { k?: unknown; f?: unknown; e?: unknown };
      if (typeof o.k !== "string" || typeof o.f !== "string" || typeof o.e !== "number") return "bad";
      if (o.e * 1000 < Date.now()) return "expired";
      return { key: o.k, file: o.f };
    } catch {
      return "bad";
    }
  }

  // ---- request classification ----
  /** Came through the gateway? Throws 401-worthy "bad gateway secret" by returning "forged". */
  viaGateway(req: FastifyRequest): boolean | "forged" {
    const h = req.headers["x-titler-gateway"];
    if (h === undefined) return false;
    const v = Array.isArray(h) ? h[0]! : h;
    return this.cfg.gatewaySecret && safeEq(v, this.cfg.gatewaySecret) ? true : "forged";
  }

  /** Who is asking: a session, a device key, or nobody. */
  identify(req: FastifyRequest): { via: "session" | "key"; key: KeyRow } | null {
    const authz = req.headers.authorization;
    if (authz?.startsWith("Bearer ")) {
      const key = this.findActive(authz.slice(7).trim(), "device");
      return key ? { via: "key", key } : null;
    }
    const cookie = readCookie(req, SESSION_COOKIE);
    if (cookie) {
      const key = this.session(cookie);
      if (key) return { via: "session", key };
    }
    return null;
  }

  /** Client address: the gateway's X-Forwarded-For when trusted, else the socket peer. */
  clientIp(req: FastifyRequest, gateway: boolean): string {
    if (gateway) {
      const xff = req.headers["x-forwarded-for"];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.ip;
  }
}

export const SESSION_COOKIE = "titler_session";

export const readCookie = (req: FastifyRequest, name: string): string | null => {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

/** Secure whenever the browser's connection is HTTPS (the gateway always is; plain-http dev isn't). */
export const sessionCookie = (value: string, maxAgeSec: number, secure: boolean): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax; Max-Age=${maxAgeSec}`;

/** The visitor's scheme: TLS on this socket, or X-Forwarded-Proto from the trusted gateway. */
export const isHttps = (req: FastifyRequest, gateway: boolean): boolean =>
  req.protocol === "https" || (gateway && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]!.trim() === "https");

// ---- rate limiting -------------------------------------------------------------------

/** Token bucket per (bucket, client): `perMin` requests per minute, bursts up to `perMin`. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  take(key: string, perMin: number): boolean {
    const t = Date.now();
    const b = this.buckets.get(key) ?? { tokens: perMin, at: t };
    b.tokens = Math.min(perMin, b.tokens + ((t - b.at) / 60_000) * perMin);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.clear(); // crude bound; limits are per minute anyway
    return true;
  }
}

/** Paths reachable without credentials even through the gateway. */
export const isPublicPath = (method: string, url: string): boolean => {
  const path = url.split("?")[0]!;
  if (path === "/api/health" || path === "/api/auth/login" || path === "/api/auth/me" || path === "/api/auth/logout") return true;
  if (path === "/api/auth/passkey" || path.startsWith("/api/auth/passkey/login/")) return true;
  if (path.startsWith("/s/")) return true;
  if (path.startsWith("/api/fonts/")) return true;
  // The SPA shell and its assets (the app shows the login screen itself).
  return !path.startsWith("/api/") && (method === "GET" || method === "HEAD");
};

export const applyCors = (req: FastifyRequest, reply: FastifyReply, origins: string[]): boolean => {
  const origin = req.headers.origin;
  if (!origin || !origins.includes(origin)) return false;
  reply
    .header("Access-Control-Allow-Origin", origin)
    .header("Access-Control-Allow-Credentials", "true")
    .header("Vary", "Origin")
    .header("Access-Control-Allow-Headers", "authorization, content-type, range")
    .header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE")
    .header("Access-Control-Expose-Headers", "content-range, content-length, accept-ranges");
  return true;
};
