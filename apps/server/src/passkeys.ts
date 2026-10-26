import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Auth, KeyRow } from "./auth.js";
import { tx, type Db } from "./db.js";
import { now } from "./store.js";

// Passkey (WebAuthn) login for the owner, beside the owner token (which stays the fallback).
//
// The relying party is the public origin behind the gateway (TITLER_PUBLIC_ORIGIN, e.g.
// https://titler.example.org): its host name is the RP ID and the only accepted origin.
// Unset → passkeys are off and the UI says why. A passkey is registered from an owner
// session (or locally), gets its own auth_keys row (kind 'passkey', listed and revocable
// with the device keys) and logs in to the same session cookie as the token.
// Challenges are single-use, in memory, 5 minutes; a restart just means "try again".

export interface PasskeyStatus {
  enabled: boolean;
  /** Why not (enabled = false). */
  reason?: string;
  /** The only origin passkeys work on; the browser must be there. */
  origin?: string;
  rpId?: string;
}

const CHALLENGE_TTL_MS = 5 * 60_000;

type Row = Record<string, unknown>;

export class Passkeys {
  private challenges = new Map<string, { purpose: "register" | "login"; expires: number }>();
  readonly status: PasskeyStatus;
  private rp: { origin: string; id: string } | null = null;

  constructor(
    private db: Db,
    private auth: Auth,
    publicOrigin: string | null | undefined,
  ) {
    this.status = { enabled: false, reason: "TITLER_PUBLIC_ORIGIN is not set" };
    if (!publicOrigin) return;
    let url: URL;
    try {
      url = new URL(publicOrigin);
    } catch {
      this.status = { enabled: false, reason: `TITLER_PUBLIC_ORIGIN is not a URL: ${publicOrigin}` };
      return;
    }
    // WebAuthn needs a secure context: https, or http on localhost for development.
    if (url.protocol !== "https:" && url.hostname !== "localhost") {
      this.status = { enabled: false, reason: "TITLER_PUBLIC_ORIGIN must be https" };
      return;
    }
    this.rp = { origin: url.origin, id: url.hostname };
    this.status = { enabled: true, origin: url.origin, rpId: url.hostname };
  }

  private need(): { origin: string; id: string } {
    if (!this.rp) throw new PasskeyError(400, `passkeys are off: ${this.status.reason}`);
    return this.rp;
  }

  private issue(purpose: "register" | "login", challenge: string): void {
    const t = Date.now();
    for (const [c, v] of this.challenges) if (v.expires < t) this.challenges.delete(c);
    // Bounded: drop the oldest (Map keeps insertion order), never the whole set, so a burst of
    // anonymous login options can't wipe the owner's in-flight challenge.
    while (this.challenges.size >= 1000) this.challenges.delete(this.challenges.keys().next().value!);
    this.challenges.set(challenge, { purpose, expires: t + CHALLENGE_TTL_MS });
  }

  /** Single use: a challenge we issued for this purpose and that hasn't expired. */
  private consume(purpose: "register" | "login", challenge: string): boolean {
    const v = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    return !!v && v.purpose === purpose && v.expires >= Date.now();
  }

  /** One WebAuthn user handle for the owner, so a device keeps one passkey per Titler. */
  private userId(): Uint8Array<ArrayBuffer> {
    const r = this.db.prepare("SELECT v FROM settings_kv WHERE k = 'passkey_user_id'").get() as Row | undefined;
    if (r) return new Uint8Array(Buffer.from(r.v as string, "base64url"));
    const id = randomBytes(16);
    this.db.prepare("INSERT INTO settings_kv (k, v) VALUES ('passkey_user_id', ?)").run(id.toString("base64url"));
    return new Uint8Array(id);
  }

  private active(): { cred_id: string; transports: string | null }[] {
    return this.db
      .prepare("SELECT p.cred_id, p.transports FROM passkeys p JOIN auth_keys k ON k.id = p.key_id WHERE k.revoked_at IS NULL")
      .all() as { cred_id: string; transports: string | null }[];
  }

  // ---- registration (owner) ----
  async registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const rp = this.need();
    const opts = await generateRegistrationOptions({
      rpName: "Titler",
      rpID: rp.id,
      userName: "owner",
      userDisplayName: "Titler owner",
      userID: this.userId(),
      attestationType: "none",
      excludeCredentials: this.active().map((c) => ({ id: c.cred_id, transports: c.transports ? (JSON.parse(c.transports) as string[]) : undefined })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    this.issue("register", opts.challenge);
    return opts;
  }

  async register(name: string, response: RegistrationResponseJSON): Promise<KeyRow> {
    const rp = this.need();
    let v;
    try {
      v = await verifyRegistrationResponse({
        response,
        expectedChallenge: (c) => this.consume("register", c),
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
      });
    } catch (e) {
      throw new PasskeyError(400, `passkey not accepted: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!v.verified) throw new PasskeyError(400, "passkey not accepted");
    const { credential } = v.registrationInfo;
    if (this.db.prepare("SELECT 1 FROM passkeys WHERE cred_id = ?").get(credential.id)) throw new PasskeyError(409, "this passkey is already registered");
    return tx(this.db, () => {
      const { key } = this.auth.createKey("passkey", name);
      this.db
        .prepare("INSERT INTO passkeys (cred_id, key_id, public_key, counter, transports, created_at) VALUES (?,?,?,?,?,?)")
        .run(credential.id, key.id, Buffer.from(credential.publicKey).toString("base64url"), credential.counter, credential.transports ? JSON.stringify(credential.transports) : null, now());
      return key;
    });
  }

  // ---- login ----
  async loginOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const rp = this.need();
    // No allowCredentials: discoverable credentials, the browser offers the owner's passkeys.
    const opts = await generateAuthenticationOptions({ rpID: rp.id, userVerification: "required" });
    this.issue("login", opts.challenge);
    return opts;
  }

  /** Verified → a session for the passkey's key row (same cookie as the owner token). */
  async login(response: AuthenticationResponseJSON): Promise<ReturnType<Auth["startSession"]>> {
    const rp = this.need();
    const row = this.db
      .prepare("SELECT p.*, k.revoked_at FROM passkeys p JOIN auth_keys k ON k.id = p.key_id WHERE p.cred_id = ?")
      .get(String(response?.id ?? "")) as Row | undefined;
    if (!row || row.revoked_at) throw new PasskeyError(401, "unknown passkey");
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (c) => this.consume("login", c),
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        credential: {
          id: row.cred_id as string,
          publicKey: new Uint8Array(Buffer.from(row.public_key as string, "base64url")),
          counter: Number(row.counter),
          transports: row.transports ? (JSON.parse(row.transports as string) as string[]) : undefined,
        },
        requireUserVerification: true,
      });
    } catch (e) {
      throw new PasskeyError(401, `passkey not accepted: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!v.verified) throw new PasskeyError(401, "passkey not accepted");
    const next = v.authenticationInfo.newCounter;
    // Re-read the counter after the (async) verification: two logins verified concurrently must
    // not move it backwards, and the slower one with an older counter is a replay or a clone.
    // Authenticators that always send 0 (most synced passkeys) don't use counters at all.
    return tx(this.db, () => {
      const cur = this.db.prepare("SELECT counter FROM passkeys WHERE cred_id = ?").get(row.cred_id as string) as { counter: number } | undefined;
      if (!cur) throw new PasskeyError(401, "unknown passkey");
      if (next > 0 && next <= Number(cur.counter)) throw new PasskeyError(401, "passkey not accepted: signature counter went backwards");
      if (next > 0) this.db.prepare("UPDATE passkeys SET counter = ? WHERE cred_id = ?").run(next, row.cred_id as string);
      this.db.prepare("UPDATE auth_keys SET last_used_at = ? WHERE id = ?").run(now(), row.key_id as string);
      return this.auth.startSession(this.auth.getKey(row.key_id as string)!);
    });
  }
}

export class PasskeyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
