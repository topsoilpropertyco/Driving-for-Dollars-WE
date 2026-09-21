import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import recorder from "../cloudflare/recorder_worker.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

class FakeRecorderD1 {
  constructor(deviceId, tokenHash) {
    this.deviceId = deviceId;
    this.tokenHash = tokenHash;
    this.points = new Set();
  }

  prepare(sql) {
    return { bind: (...args) => ({ first: () => this.first(sql, args), run: () => this.run(sql, args) }) };
  }

  async first(sql, args) {
    if (!sql.includes("FROM recorder_devices")) throw new Error("unexpected lookup");
    return args[0] === this.deviceId ? { token_hash: this.tokenHash } : null;
  }

  async run(sql, args) {
    if (!sql.includes("INSERT OR IGNORE INTO recorder_points")) throw new Error("unexpected write");
    this.points.add(args.slice(0, 4).join("|"));
    return { meta: { changes: 1 } };
  }
}

const deviceId = "pilot-01234567";
const token = "a".repeat(43);
const db = new FakeRecorderD1(deviceId, await hash(token));
const env = { DB: db };
const now = Date.now();
const validPath = `/?id=${deviceId}&token=${token}&lat=42.4&lon=-82.9&timestamp=${now}&accuracy=8&speed=10&bearing=180`;

assert.equal((await recorder.fetch(new Request("https://ingest.example/"), env)).status, 400);
assert.equal((await recorder.fetch(new Request(`https://ingest.example/?id=${deviceId}&token=${"b".repeat(43)}&lat=42.4&lon=-82.9&timestamp=${now}`), env)).status, 401);
assert.equal((await recorder.fetch(new Request(`https://ingest.example${validPath}`), env)).status, 200);
assert.equal((await recorder.fetch(new Request(`https://ingest.example${validPath}`), env)).status, 200);
assert.equal(db.points.size, 1);
assert.equal((await recorder.fetch(new Request(`https://ingest.example/?id=${deviceId}&token=${token}&lat=42.4&lon=-82.9&timestamp=${now - 15 * 24 * 60 * 60 * 1000}`), env)).status, 400);
assert.equal((await recorder.fetch(new Request("https://ingest.example/readback"), env)).status, 404);

console.log("recorder ingest contract: passed");
