import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import worker from "../cloudflare/worker.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

class FakeBootstrapD1 {
  constructor() { this.devices = []; }

  prepare(sql) {
    return { bind: (...args) => ({ run: () => this.run(sql, args) }) };
  }

  async batch(statements) { return Promise.all(statements.map(statement => statement.run())); }

  async run(sql, args) {
    if (sql.includes("UPDATE recorder_devices SET revoked_at")) return { meta: { changes: 0 } };
    if (!sql.includes("INSERT INTO recorder_devices")) throw new Error("unexpected write");
    this.devices.push(args);
    return { meta: { changes: 1 } };
  }
}

const db = new FakeBootstrapD1();
const env = {
  DB: db,
  ALLOWED_EMAILS: "seth@example.test",
  RECORDER_INGEST_URL: "https://ingest.example/",
};
const headers = { "content-type": "application/json", "Cf-Access-Authenticated-User-Email": "seth@example.test" };

const invalid = await worker.fetch(new Request("https://private.example/api/v1/recorders/bootstrap", { method: "POST", headers, body: JSON.stringify({ unexpected: true }) }), env);
assert.equal(invalid.status, 400);

const created = await worker.fetch(new Request("https://private.example/api/v1/recorders/bootstrap", { method: "POST", headers, body: "{}" }), env);
assert.equal(created.status, 201);
const body = await created.json();
assert.match(body.device_id, /^pilot-/);
assert.match(body.server_url, /^https:\/\/ingest\.example\/\?token=/);
assert.equal(db.devices.length, 1);
assert.equal(db.devices[0][0], body.device_id);
assert.match(db.devices[0][1], /^[a-f0-9]{64}$/);
assert.equal(db.devices[0][2], "seth@example.test");

const blocked = await worker.fetch(new Request("https://private.example/api/v1/recorders/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), env);
assert.equal(blocked.status, 401);

console.log("recorder bootstrap contract: passed");
