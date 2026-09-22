import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";

class FakeActionD1 {
  constructor() { this.actions = new Map(); }

  prepare(sql) {
    return { bind: (...args) => ({ execute: () => this.execute(sql, args), all: () => this.all(sql, args) }) };
  }

  async batch(statements) { return Promise.all(statements.map(statement => statement.execute())); }

  async execute(sql, args) {
    if (!sql.includes("INSERT OR IGNORE INTO household_actions")) throw new Error("Unhandled write");
    const [eventId, deviceId, sequence, occurredAt, kind, propertyIdentity, payloadJson, receivedAt] = args;
    if (this.actions.has(eventId)) return { meta: { changes: 0 } };
    this.actions.set(eventId, { event_id: eventId, device_id: deviceId, sequence, occurred_at: occurredAt, kind, property_identity: propertyIdentity, payload_json: payloadJson, received_at: receivedAt });
    return { meta: { changes: 1 } };
  }

  async all(sql, args) {
    const all = [...this.actions.values()].sort((a, b) => a.property_identity.localeCompare(b.property_identity) || a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id));
    if (sql.includes("FROM household_actions WHERE property_identity")) return { results: all.filter(action => action.property_identity === args[0]) };
    if (sql.includes("SELECT property_identity, occurred_at, kind, payload_json FROM household_actions")) return { results: all };
    throw new Error("Unhandled read");
  }
}

const db = new FakeActionD1();
const env = { DB: db, ALLOWED_EMAILS: "seth@example.test,claire@example.test" };
const propertyIdentity = "MI:WAYNE:SYNTHETIC-100";
const actions = [
  { event_id: "00000000-0000-4000-8000-000000000001", device_id: "synthetic-phone", sequence: 1, occurred_at: "2026-09-20T12:00:00Z", kind: "property_saved", property_identity: propertyIdentity, payload: {} },
  { event_id: "00000000-0000-4000-8000-000000000002", device_id: "synthetic-phone", sequence: 2, occurred_at: "2026-09-20T12:01:00Z", kind: "stage_changed", property_identity: propertyIdentity, payload: { stage: "in_conversation" } },
  { event_id: "00000000-0000-4000-8000-000000000003", device_id: "synthetic-phone", sequence: 3, occurred_at: "2026-09-20T12:02:00Z", kind: "note_added", property_identity: propertyIdentity, payload: { note: "synthetic field note" } },
  { event_id: "00000000-0000-4000-8000-000000000004", device_id: "synthetic-phone", sequence: 4, occurred_at: "2026-09-20T12:03:00Z", kind: "property_tagged", property_identity: propertyIdentity, payload: { condition: "needs_work", score: 4, latitude: 42.4, longitude: -82.9 } },
];

function jsonRequest(path, email, body) {
  const text = JSON.stringify(body);
  return new Request(`https://private.example.test${path}`, { method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), "Cf-Access-Authenticated-User-Email": email }, body: text });
}

const denied = await worker.fetch(jsonRequest("/api/v1/actions", "outside@example.test", { actions }), env);
assert.equal(denied.status, 401);

const malformed = await worker.fetch(jsonRequest("/api/v1/actions", "seth@example.test", { actions: [{ ...actions[0], payload: { unexpected: "field" } }] }), env);
assert.equal(malformed.status, 400);
assert.equal(db.actions.size, 0);

const accepted = await worker.fetch(jsonRequest("/api/v1/actions", "seth@example.test", { actions }), env);
assert.equal(accepted.status, 202);
assert.deepEqual((await accepted.json()).accepted_event_ids, actions.map(action => action.event_id));

const replay = await worker.fetch(jsonRequest("/api/v1/actions", "seth@example.test", { actions }), env);
assert.equal(replay.status, 202);
assert.deepEqual((await replay.json()).already_seen_event_ids, actions.map(action => action.event_id));

const claireProperty = "MI:WAYNE:SYNTHETIC-200";
const claireAction = { event_id: "00000000-0000-4000-8000-000000000005", device_id: "second-synthetic-phone", sequence: 1, occurred_at: "2026-09-20T12:04:00Z", kind: "property_saved", property_identity: claireProperty, payload: {} };
const claireAccepted = await worker.fetch(jsonRequest("/api/v1/actions", "claire@example.test", { actions: [claireAction] }), env);
assert.equal(claireAccepted.status, 202);
assert.deepEqual((await claireAccepted.json()).accepted_event_ids, [claireAction.event_id]);

const timeline = await worker.fetch(new Request(`https://private.example.test/api/v1/properties/${propertyIdentity}`, { headers: { "Cf-Access-Authenticated-User-Email": "claire@example.test" } }), env);
assert.equal(timeline.status, 200);
const body = await timeline.json();
assert.equal(body.summary.saved, true);
assert.equal(body.summary.stage, "in_conversation");
assert.deepEqual(body.summary.notes, ["synthetic field note"]);
assert.equal(body.summary.action_count, 4);
assert.equal(body.summary.condition, "needs_work");
assert.equal(body.summary.score, 4);
assert.deepEqual(body.summary.location, [-82.9, 42.4]);

const savedHomes = await worker.fetch(new Request("https://private.example.test/api/v1/properties", { headers: { "Cf-Access-Authenticated-User-Email": "seth@example.test" } }), env);
assert.equal(savedHomes.status, 200);
assert.deepEqual(await savedHomes.json(), { properties: [
  { property_identity: claireProperty, saved: true, stage: "no_outreach", condition: null, score: null, location: null, action_count: 1, last_activity_at: "2026-09-20T12:04:00Z" },
  { property_identity: propertyIdentity, saved: true, stage: "in_conversation", condition: "needs_work", score: 4, location: [-82.9, 42.4], action_count: 4, last_activity_at: "2026-09-20T12:03:00Z" },
] });

console.log("worker actions contract: passed");
