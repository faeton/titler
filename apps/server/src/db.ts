import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Schema migrations, applied in order; PRAGMA user_version = number applied.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source_sha256 TEXT NOT NULL UNIQUE,
    source_name TEXT NOT NULL,
    source_path TEXT NOT NULL,
    probe_json TEXT,
    settings_json TEXT NOT NULL,
    transcript_rev INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    last_modified TEXT,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE artifacts (
    key TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX artifacts_project ON artifacts(project_id, kind);
  CREATE TABLE transcript_revs (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    rev INTEGER NOT NULL,
    doc_json TEXT NOT NULL,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, rev)
  );
  CREATE TABLE hypotheses (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    audio_key TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    lang TEXT,
    words_json TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  CREATE INDEX hypotheses_project ON hypotheses(project_id, created_at);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    resource_class TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    params_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    progress REAL,
    message TEXT,
    error TEXT,
    result_json TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX jobs_status ON jobs(status, resource_class, priority, created_at);
  CREATE INDEX jobs_project ON jobs(project_id, created_at);
  `,
  `
  CREATE TABLE auth_keys (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,            -- 'owner' (logs in, makes sessions) | 'device' (Bearer)
    name TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,     -- sha256 of the secret; the secret itself is shown once
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE sessions (
    hash TEXT PRIMARY KEY,         -- sha256 of the cookie value
    key_id TEXT NOT NULL REFERENCES auth_keys(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE settings_kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
  `,
  `
  -- WebAuthn passkeys. Each has its own auth_keys row (kind 'passkey'): sessions point at it,
  -- and revoking that row disables the passkey and ends its sessions.
  CREATE TABLE passkeys (
    cred_id TEXT PRIMARY KEY,      -- credential ID, base64url
    key_id TEXT NOT NULL UNIQUE REFERENCES auth_keys(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,      -- COSE public key, base64url
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,               -- JSON array, as reported at registration
    created_at TEXT NOT NULL
  );
  `,
];

export type Db = DatabaseSync;

export const openDb = (path: string): Db => {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
};

export const migrate = (db: Db): number => {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let v = row.user_version;
  while (v < MIGRATIONS.length) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
    v++;
  }
  return v;
};

/** Run fn in an IMMEDIATE transaction (synchronous; nested calls join the outer one). */
export const tx = <T>(db: Db, fn: () => T): T => {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};
