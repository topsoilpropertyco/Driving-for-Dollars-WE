import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";

class CoverageDb {
  constructor() { this.rows = new Map([["old:1", { segment_id: "old:1", last_seen_at: "2026-09-01T00:00:00.000Z" }]]); }
  prepare(sql) { return { bind: (...args) => ({ all: () => this.all(sql, args), execute: () => this.execute(sql, args) }) }; }
  async all() { return { results: [...this.rows.values()] }; }
  async execute(_sql, args) { const [, segmentId, , lastSeen] = args; this.rows.set(segmentId, { segment_id: segmentId, last_seen_at: lastSeen }); return { meta: { changes: 1 } }; }
  async batch(statements) { return Promise.all(statements.map(statement => statement.execute())); }
}

const env = { DB: new CoverageDb(), ALLOWED_EMAILS: "home@example.test" };
const headers = { "Cf-Access-Authenticated-User-Email": "home@example.test", "content-type": "application/json" };
const start = await worker.fetch(new Request("https://private.example.test/api/v1/coverage-preview", { method: "POST", headers, body: JSON.stringify({ segments: [], start_fresh_campaign: true }) }), env);
assert.equal(start.status, 200);
assert.match((await start.json()).campaign_started_at, /^\d{4}-/);
const history = await worker.fetch(new Request("https://private.example.test/api/v1/coverage-preview", { headers }), env);
assert.equal(history.status, 200);
const body = await history.json();
assert.deepEqual(body.segments, ["old:1"]);
assert.equal(body.entries[0].last_seen_at, "2026-09-01T00:00:00.000Z");
assert.match(body.campaign_started_at, /^\d{4}-/);
console.log("coverage campaign contract: passed");
