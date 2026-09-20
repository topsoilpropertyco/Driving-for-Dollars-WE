// Private Worker API. Cloudflare Access must protect this route; this code
// additionally restricts authenticated identities to the household allow-list.

const MAX_BODY_BYTES = 100_000;
const STAGES = new Set([
  "no_outreach", "reached_out", "waiting_for_reply", "in_conversation",
  "contractor_offer", "realtor_referral", "closed", "archived",
]);
const KINDS = new Set(["property_saved", "note_added", "stage_changed", "outreach_logged"]);

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function allowedEmail(request, env) {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email")?.trim().toLowerCase();
  const allowed = new Set((env.ALLOWED_EMAILS || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  return email && allowed.has(email) ? email : null;
}

function validUtc(value) {
  return typeof value === "string" && value.endsWith("Z") && !Number.isNaN(Date.parse(value));
}

function validateAction(value) {
  const fields = ["event_id", "device_id", "sequence", "occurred_at", "kind", "property_identity", "payload"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length || !fields.every(field => field in value)) return false;
  if (typeof value.event_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.event_id)) return false;
  if (typeof value.device_id !== "string" || !value.device_id || value.device_id.length > 128) return false;
  if (!Number.isInteger(value.sequence) || value.sequence < 1 || !validUtc(value.occurred_at)) return false;
  if (!KINDS.has(value.kind) || typeof value.property_identity !== "string" || !value.property_identity || value.property_identity.length > 256) return false;
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) return false;
  if (value.kind === "property_saved") return Object.keys(value.payload).length === 0;
  if (value.kind === "stage_changed") return Object.keys(value.payload).length === 1 && STAGES.has(value.payload.stage);
  if (value.kind === "note_added") return Object.keys(value.payload).length === 1 && typeof value.payload.note === "string" && value.payload.note.trim();
  return Object.keys(value.payload).length === 1 && typeof value.payload.method === "string" && value.payload.method.trim();
}

async function actions(request, env) {
  const length = Number(request.headers.get("content-length") || 0);
  if (!Number.isFinite(length) || length < 1 || length > MAX_BODY_BYTES) return json({ error: "invalid_request" }, 400);
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_request" }, 400); }
  if (!Array.isArray(body.actions) || !body.actions.length || !body.actions.every(validateAction)) return json({ error: "invalid_request" }, 400);
  const receivedAt = new Date().toISOString();
  const statements = body.actions.map(action => env.DB.prepare(
    "INSERT OR IGNORE INTO household_actions (event_id, device_id, sequence, occurred_at, kind, property_identity, payload_json, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(action.event_id, action.device_id, action.sequence, action.occurred_at, action.kind, action.property_identity, JSON.stringify(action.payload), receivedAt));
  const results = await env.DB.batch(statements);
  return json({
    accepted_event_ids: body.actions.filter((_, index) => results[index].meta.changes === 1).map(action => action.event_id),
    already_seen_event_ids: body.actions.filter((_, index) => results[index].meta.changes === 0).map(action => action.event_id),
  }, 202);
}

async function property(identity, env) {
  const rows = await env.DB.prepare(
    "SELECT event_id, occurred_at, kind, payload_json FROM household_actions WHERE property_identity = ? ORDER BY occurred_at, event_id"
  ).bind(identity).all();
  let stage = "no_outreach";
  const notes = [], outreach_methods = [], timeline = [];
  for (const row of rows.results) {
    const payload = JSON.parse(row.payload_json);
    if (row.kind === "stage_changed") stage = payload.stage;
    if (row.kind === "note_added") notes.push(payload.note);
    if (row.kind === "outreach_logged") outreach_methods.push(payload.method);
    timeline.push({ event_id: row.event_id, occurred_at: row.occurred_at, kind: row.kind, payload });
  }
  return json({ summary: { property_identity: identity, saved: timeline.some(item => item.kind === "property_saved"), stage, notes, outreach_methods, action_count: timeline.length }, timeline });
}

export default {
  async fetch(request, env) {
    // Do not serve a fallback public app from this private Worker.
    if (!allowedEmail(request, env)) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return json({ status: "private-ready" });
      if (request.method === "POST" && url.pathname === "/api/v1/actions") return actions(request, env);
      if (request.method === "GET" && url.pathname.startsWith("/api/v1/properties/")) return property(decodeURIComponent(url.pathname.slice("/api/v1/properties/".length)), env);
    } catch {
      // Avoid returning raw database or payload details to clients or logs.
      return json({ error: "service_unavailable" }, 503);
    }
    return json({ error: "not_found" }, 404);
  },
};
