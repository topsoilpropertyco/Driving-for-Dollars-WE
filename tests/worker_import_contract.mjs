import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";

class FakeD1 {
  constructor() {
    this.runs = new Map();
    this.records = new Map();
  }

  prepare(sql) {
    return {
      bind: (...args) => ({ sql, args, execute: () => this.execute(sql, args), first: () => this.first(sql, args), all: () => this.all(sql, args), run: () => this.execute(sql, args) }),
    };
  }

  async batch(statements) {
    return Promise.all(statements.map(statement => statement.execute()));
  }

  key(importId, rowNumber) { return `${importId}:${rowNumber}`; }

  async execute(sql, args) {
    if (sql.includes("INSERT INTO import_runs")) {
      const [importId, sourceName, fingerprint, createdAt, acceptedCount, rejectedCount] = args;
      if (this.runs.has(importId)) throw new Error("duplicate run");
      this.runs.set(importId, { import_id: importId, source_name: sourceName, source_fingerprint: fingerprint, status: "staged", created_at: createdAt, accepted_count: acceptedCount, rejected_count: rejectedCount });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO import_plan_records")) {
      const [importId, rowNumber, identityKind, identityKey, reviewRequired, sourceFields] = args;
      this.records.set(this.key(importId, rowNumber), { import_id: importId, row_number: rowNumber, identity_kind: identityKind, identity_key: identityKey, review_required: reviewRequired, source_fields_json: sourceFields, status: "queued" });
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE import_plan_records SET status")) {
      const [status, importId, rowNumber] = args;
      this.records.get(this.key(importId, rowNumber)).status = status;
      return { meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE import_runs SET status")) {
      const [importId] = args;
      const run = this.runs.get(importId);
      if (run.status === "staged") run.status = "ready_for_review";
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unhandled write: ${sql}`);
  }

  async first(sql, args) {
    if (sql.includes("WHERE source_name = ? AND source_fingerprint = ?")) {
      const [sourceName, fingerprint] = args;
      return [...this.runs.values()].find(run => run.source_name === sourceName && run.source_fingerprint === fingerprint) || null;
    }
    if (sql.includes("SELECT import_id FROM import_runs WHERE import_id")) return this.runs.get(args[0]) || null;
    if (sql.includes("SELECT COUNT(*) AS queued_count")) return { queued_count: [...this.records.values()].filter(record => record.import_id === args[0] && record.status === "queued").length };
    if (sql.includes("SELECT r.status, COUNT(p.row_number) AS total_records")) {
      const run = this.runs.get(args[0]);
      if (!run) return null;
      const records = [...this.records.values()].filter(record => record.import_id === args[0]);
      return { status: run.status, total_records: records.length, processed_records: records.filter(record => record.status !== "queued").length, review_records: records.filter(record => record.status === "review_required").length };
    }
    throw new Error(`Unhandled first: ${sql}`);
  }

  async all(sql, args) {
    if (sql.includes("FROM import_plan_records WHERE import_id = ? AND status = 'queued'")) {
      const [importId, limit] = args;
      return { results: [...this.records.values()].filter(record => record.import_id === importId && record.status === "queued").sort((a, b) => a.row_number - b.row_number).slice(0, limit) };
    }
    throw new Error(`Unhandled all: ${sql}`);
  }
}

const emailHeaders = { "Cf-Access-Authenticated-User-Email": "seth@example.test", "content-type": "application/json" };
const validPlan = {
  source_name: "synthetic-provider",
  source_fingerprint: "0123456789abcdef",
  rejected_count: 1,
  records: [
    { row_number: 2, identity_kind: "apn", identity_key: "MI:WAYNE:100", review_required: false, source_fields_present: ["apn", "city"] },
    { row_number: 3, identity_kind: "address_candidate", identity_key: "MI:GROSSEPOINTE:MAIN", review_required: true, source_fields_present: ["address", "city"] },
  ],
};

async function request(url, options = {}) {
  return worker.fetch(new Request(`https://private.example.test${url}`, options), { DB: db, ALLOWED_EMAILS: "seth@example.test,claire@example.test" });
}

const db = new FakeD1();

const unauthorized = await worker.fetch(new Request("https://private.example.test/api/v1/import-plans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(validPlan) }), { DB: db, ALLOWED_EMAILS: "seth@example.test" });
assert.equal(unauthorized.status, 401);

const invalid = await request("/api/v1/import-plans", { method: "POST", headers: emailHeaders, body: JSON.stringify({ ...validPlan, owner_name: "must-not-accept" }) });
assert.equal(invalid.status, 400);
assert.equal(db.runs.size, 0);

const staged = await request("/api/v1/import-plans", { method: "POST", headers: emailHeaders, body: JSON.stringify(validPlan) });
assert.equal(staged.status, 201);
const started = await staged.json();
assert.equal(started.status, "staged");
assert.equal(started.total_records, 2);

const replay = await request("/api/v1/import-plans", { method: "POST", headers: emailHeaders, body: JSON.stringify(validPlan) });
assert.equal(replay.status, 200);
assert.equal((await replay.json()).import_id, started.import_id);

const firstBatch = await request(`/api/v1/import-plans/${started.import_id}/advance`, { method: "POST", headers: emailHeaders, body: JSON.stringify({ batch_size: 1 }) });
assert.deepEqual(await firstBatch.json(), { ...started, processed_records: 1, review_records: 0 });

const resumed = await request(`/api/v1/import-plans/${started.import_id}`, { headers: emailHeaders });
assert.deepEqual(await resumed.json(), { ...started, processed_records: 1, review_records: 0 });

const finished = await request(`/api/v1/import-plans/${started.import_id}/advance`, { method: "POST", headers: emailHeaders, body: JSON.stringify({ batch_size: 500 }) });
assert.deepEqual(await finished.json(), { ...started, status: "ready_for_review", processed_records: 2, review_records: 1 });

console.log("worker import contract: passed");
