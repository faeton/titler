// Owner tokens and device keys, straight on the database (safe while the server runs: WAL).
//   pnpm --filter @titler/server auth owner [name]     new owner token (log in with it on the web)
//   pnpm --filter @titler/server auth device <name>    new device key (Authorization: Bearer …)
//   pnpm --filter @titler/server auth list
//   pnpm --filter @titler/server auth revoke <id>
// Secrets are printed once; only their hashes are stored. TITLER_DATA picks the data dir.
import { resolve } from "node:path";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";

const [cmd, arg] = process.argv.slice(2);
const cfg = loadConfig();
const db = openDb(resolve(cfg.dataDir, "titler.db"));
const auth = new Auth(db, cfg.auth);

if (cmd === "owner" || cmd === "device") {
  if (cmd === "device" && !arg) throw new Error("device key needs a name");
  const { key, secret } = auth.createKey(cmd, arg ?? "owner");
  console.log(`${key.kind} key ${key.id} "${key.name}"\n${secret}\n(shown once — store it now)`);
} else if (cmd === "list") {
  for (const k of auth.listKeys()) console.log(`${k.id}  ${k.kind.padEnd(6)}  ${k.name.padEnd(24)}  created ${k.createdAt}  used ${k.lastUsedAt ?? "-"}${k.revokedAt ? `  REVOKED ${k.revokedAt}` : ""}`);
} else if (cmd === "revoke" && arg) {
  console.log(auth.revokeKey(arg) ? `revoked ${arg}` : `no active key ${arg}`);
} else {
  console.log("usage: auth owner [name] | device <name> | list | revoke <id>");
  process.exitCode = 2;
}
db.close();
