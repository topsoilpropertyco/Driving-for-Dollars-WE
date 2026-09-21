// Private Worker API. Cloudflare Access must protect this route; this code
// additionally restricts authenticated identities to the household allow-list.

const MAX_BODY_BYTES = 100_000;
const STAGES = new Set([
  "no_outreach", "reached_out", "waiting_for_reply", "in_conversation",
  "contractor_offer", "realtor_referral", "closed", "archived",
]);
const KINDS = new Set(["property_saved", "note_added", "stage_changed", "outreach_logged"]);
const IMPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function bootstrapRecorder(request, env, email) {
  let body = {};
  try { body = await request.json(); } catch { return json({ error: "invalid_request" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) return json({ error: "invalid_request" }, 400);
  if (typeof env.RECORDER_INGEST_URL !== "string" || !env.RECORDER_INGEST_URL.startsWith("https://")) return json({ error: "service_unavailable" }, 503);
  const deviceId = `pilot-${crypto.randomUUID()}`;
  const token = randomToken();
  const createdAt = new Date().toISOString();
  // A new setup deliberately rotates any earlier setup made by this household
  // email, so a copied credential does not remain usable after re-provisioning.
  await env.DB.batch([
    env.DB.prepare("UPDATE recorder_devices SET revoked_at = ? WHERE created_by_email = ? AND revoked_at IS NULL").bind(createdAt, email),
    env.DB.prepare(
      "INSERT INTO recorder_devices (device_id, token_hash, created_by_email, created_at) VALUES (?, ?, ?, ?)"
    ).bind(deviceId, await sha256(token), email, createdAt),
  ]);
  return json({
    device_id: deviceId,
    server_url: `${env.RECORDER_INGEST_URL}?token=${encodeURIComponent(token)}`,
    privacy_notice: "This one-time setup value is shown only in this private session. Do not share it.",
  }, 201);
}

async function recorderStatus(env, email) {
  // Deliberately return aggregate delivery health only. Location data stays in
  // the isolated recorder store and is never exposed to the phone dashboard.
  const row = await env.DB.prepare(
    "SELECT COUNT(DISTINCT d.device_id) AS active_devices, COUNT(p.device_id) AS points_received, MAX(p.received_at) AS latest_received_at, MAX(p.recorded_at) AS latest_recorded_at FROM recorder_devices d LEFT JOIN recorder_points p ON p.device_id = d.device_id WHERE d.created_by_email = ? AND d.revoked_at IS NULL"
  ).bind(email).first();
  return json({
    active_devices: Number(row?.active_devices || 0),
    points_received: Number(row?.points_received || 0),
    latest_received_at: row?.latest_received_at || null,
    latest_recorded_at: row?.latest_recorded_at || null,
  });
}

const ROUTE_SESSION_GAP_MS = 15 * 60 * 1000;

async function recorderRoutePoints(env, email) {
  const result = await env.DB.prepare(
    "SELECT p.recorded_at, p.latitude, p.longitude FROM recorder_points p JOIN recorder_devices d ON d.device_id = p.device_id WHERE d.created_by_email = ? AND d.revoked_at IS NULL ORDER BY p.recorded_at DESC LIMIT 5000"
  ).bind(email).all();
  return (result.results || []).reverse().filter(row =>
    typeof row.recorded_at === "string" && Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))
  );
}

function recorderSessions(rows) {
  const sessions = [];
  let current = [];
  for (const row of rows) {
    const previous = current.at(-1);
    const previousTime = previous ? Date.parse(previous.recorded_at) : NaN;
    const currentTime = Date.parse(row.recorded_at);
    if (current.length && (!Number.isFinite(previousTime) || !Number.isFinite(currentTime) || currentTime - previousTime > ROUTE_SESSION_GAP_MS)) {
      sessions.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length) sessions.push(current);
  return sessions;
}

function metersBetween(first, second) {
  const radians = degrees => degrees * Math.PI / 180;
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = radians(Number(second.latitude) - Number(first.latitude));
  const longitudeDelta = radians(Number(second.longitude) - Number(first.longitude));
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(Number(first.latitude))) * Math.cos(radians(Number(second.latitude))) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function routePayload(session) {
  let distanceMeters = 0;
  let largestGapMeters = 0;
  for (let index = 1; index < session.length; index += 1) {
    const gap = metersBetween(session[index - 1], session[index]);
    distanceMeters += gap;
    largestGapMeters = Math.max(largestGapMeters, gap);
  }
  const started = Date.parse(session[0]?.recorded_at || "");
  const ended = Date.parse(session.at(-1)?.recorded_at || "");
  return {
    session_id: session[0]?.recorded_at || null,
    point_count: session.length,
    started_at: session[0]?.recorded_at || null,
    ended_at: session.at(-1)?.recorded_at || null,
    sampled_distance_meters: Math.round(distanceMeters),
    largest_gap_meters: Math.round(largestGapMeters),
    duration_seconds: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, Math.round((ended - started) / 1000)) : 0,
    // [longitude, latitude] keeps the payload compatible with GeoJSON tools.
    coordinates: session.map(row => [Number(row.longitude), Number(row.latitude)]),
  };
}

async function latestRecorderRoute(env, email, requestedSessionId = null) {
  // Coordinates are returned only to the authenticated household member who
  // created the recorder. Nothing here is served by the public ingress Worker.
  const sessions = recorderSessions(await recorderRoutePoints(env, email));
  const session = requestedSessionId ? sessions.find(candidate => candidate[0]?.recorded_at === requestedSessionId) : sessions.at(-1);
  return json(routePayload(session || []));
}

async function recorderSessionList(env, email) {
  const sessions = recorderSessions(await recorderRoutePoints(env, email));
  return json({ sessions: sessions.slice(-20).reverse().map(session => {
    const payload = routePayload(session);
    return { session_id: payload.session_id, point_count: payload.point_count, started_at: payload.started_at, ended_at: payload.ended_at, sampled_distance_meters: payload.sampled_distance_meters, largest_gap_meters: payload.largest_gap_meters, duration_seconds: payload.duration_seconds };
  }) });
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

function validateImportRecord(value) {
  const fields = ["row_number", "identity_kind", "identity_key", "review_required", "source_fields_present"];
  return value && typeof value === "object" && Object.keys(value).length === fields.length && fields.every(field => field in value)
    && Number.isInteger(value.row_number) && value.row_number > 0
    && (value.identity_kind === "apn" || value.identity_kind === "address_candidate")
    && typeof value.identity_key === "string" && value.identity_key.length > 0 && value.identity_key.length <= 256
    && typeof value.review_required === "boolean"
    && Array.isArray(value.source_fields_present) && value.source_fields_present.every(field => typeof field === "string" && field.length > 0 && field.length <= 128);
}

function validateImportPlan(value) {
  const fields = ["source_name", "source_fingerprint", "rejected_count", "records"];
  if (!value || typeof value !== "object" || Object.keys(value).length !== fields.length || !fields.every(field => field in value)) return false;
  if (typeof value.source_name !== "string" || !value.source_name.trim() || value.source_name.length > 128) return false;
  if (typeof value.source_fingerprint !== "string" || !/^[0-9a-f]{16}$/i.test(value.source_fingerprint)) return false;
  if (!Number.isInteger(value.rejected_count) || value.rejected_count < 0 || value.rejected_count > 1_000_000) return false;
  if (!Array.isArray(value.records) || value.records.length > 5_000 || !value.records.every(validateImportRecord)) return false;
  const rowNumbers = new Set(value.records.map(record => record.row_number));
  return rowNumbers.size === value.records.length;
}

async function importProgress(importId, env) {
  const row = await env.DB.prepare(
    "SELECT r.status, COUNT(p.row_number) AS total_records, SUM(CASE WHEN p.status != 'queued' THEN 1 ELSE 0 END) AS processed_records, SUM(CASE WHEN p.status = 'review_required' THEN 1 ELSE 0 END) AS review_records FROM import_runs r LEFT JOIN import_plan_records p ON p.import_id = r.import_id WHERE r.import_id = ? GROUP BY r.import_id"
  ).bind(importId).first();
  if (!row) return null;
  return {
    import_id: importId,
    status: row.status,
    total_records: Number(row.total_records || 0),
    processed_records: Number(row.processed_records || 0),
    review_records: Number(row.review_records || 0),
  };
}

async function stageImportPlan(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_request" }, 400); }
  if (!validateImportPlan(body)) return json({ error: "invalid_request" }, 400);
  const existing = await env.DB.prepare(
    "SELECT import_id FROM import_runs WHERE source_name = ? AND source_fingerprint = ?"
  ).bind(body.source_name, body.source_fingerprint).first();
  if (existing) return json(await importProgress(existing.import_id, env), 200);
  const importId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const statements = [env.DB.prepare(
    "INSERT INTO import_runs (import_id, source_name, source_fingerprint, status, created_at, accepted_count, rejected_count) VALUES (?, ?, ?, 'staged', ?, ?, ?)"
  ).bind(importId, body.source_name, body.source_fingerprint, createdAt, body.records.length, body.rejected_count)];
  for (const record of body.records) {
    statements.push(env.DB.prepare(
      "INSERT INTO import_plan_records (import_id, row_number, identity_kind, identity_key, review_required, source_fields_json, status) VALUES (?, ?, ?, ?, ?, ?, 'queued')"
    ).bind(importId, record.row_number, record.identity_kind, record.identity_key, Number(record.review_required), JSON.stringify(record.source_fields_present)));
  }
  await env.DB.batch(statements);
  return json(await importProgress(importId, env), 201);
}

async function advanceImportPlan(request, env, importId) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_request" }, 400); }
  const batchSize = body && Object.keys(body).length === 1 ? body.batch_size : null;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) return json({ error: "invalid_request" }, 400);
  const run = await env.DB.prepare("SELECT import_id FROM import_runs WHERE import_id = ?").bind(importId).first();
  if (!run) return json({ error: "not_found" }, 404);
  const queued = await env.DB.prepare(
    "SELECT row_number, review_required FROM import_plan_records WHERE import_id = ? AND status = 'queued' ORDER BY row_number LIMIT ?"
  ).bind(importId, batchSize).all();
  const statements = queued.results.map(record => env.DB.prepare(
    "UPDATE import_plan_records SET status = ? WHERE import_id = ? AND row_number = ?"
  ).bind(record.review_required ? "review_required" : "validated", importId, record.row_number));
  if (statements.length) await env.DB.batch(statements);
  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS queued_count FROM import_plan_records WHERE import_id = ? AND status = 'queued'"
  ).bind(importId).first();
  if (Number(remaining.queued_count) === 0) {
    await env.DB.prepare("UPDATE import_runs SET status = 'ready_for_review' WHERE import_id = ? AND status = 'staged'").bind(importId).run();
  }
  return json(await importProgress(importId, env));
}

async function getImportPlan(env, importId) {
  const progress = await importProgress(importId, env);
  return progress ? json(progress) : json({ error: "not_found" }, 404);
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

async function properties(env) {
  // This CRM list contains household-created identifiers and action state only.
  // It does not introduce owner, address, provider, or contact data.
  const rows = await env.DB.prepare(
    "SELECT property_identity, occurred_at, kind, payload_json FROM household_actions ORDER BY property_identity, occurred_at, event_id LIMIT 5000"
  ).bind().all();
  const summaries = new Map();
  for (const row of rows.results || []) {
    const current = summaries.get(row.property_identity) || { property_identity: row.property_identity, saved: false, stage: "no_outreach", action_count: 0, last_activity_at: row.occurred_at };
    current.saved ||= row.kind === "property_saved";
    current.action_count += 1;
    current.last_activity_at = row.occurred_at;
    if (row.kind === "stage_changed") current.stage = JSON.parse(row.payload_json).stage;
    summaries.set(row.property_identity, current);
  }
  return json({ properties: [...summaries.values()].filter(summary => summary.saved).sort((first, second) => second.last_activity_at.localeCompare(first.last_activity_at)) });
}

export default {
  async fetch(request, env) {
    // Do not serve a fallback public app from this private Worker.
    const email = allowedEmail(request, env);
    if (!email) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return json({ status: "private-ready" });
      if (request.method === "POST" && url.pathname === "/api/v1/recorders/bootstrap") return bootstrapRecorder(request, env, email);
      if (request.method === "GET" && url.pathname === "/api/v1/recorders/status") return recorderStatus(env, email);
      if (request.method === "GET" && url.pathname === "/api/v1/recorders/latest-route") {
        const sessionId = url.searchParams.get("session");
        return latestRecorderRoute(env, email, sessionId && sessionId.length <= 40 ? sessionId : null);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/recorders/sessions") return recorderSessionList(env, email);
      if (request.method === "POST" && url.pathname === "/api/v1/actions") return actions(request, env);
      if (request.method === "POST" && url.pathname === "/api/v1/import-plans") return stageImportPlan(request, env);
      const advance = url.pathname.match(/^\/api\/v1\/import-plans\/([^/]+)\/advance$/);
      if (request.method === "POST" && advance && IMPORT_ID.test(advance[1])) return advanceImportPlan(request, env, advance[1]);
      const importStatus = url.pathname.match(/^\/api\/v1\/import-plans\/([^/]+)$/);
      if (request.method === "GET" && importStatus && IMPORT_ID.test(importStatus[1])) return getImportPlan(env, importStatus[1]);
      if (request.method === "GET" && url.pathname === "/api/v1/properties") return properties(env);
      if (request.method === "GET" && url.pathname.startsWith("/api/v1/properties/")) return property(decodeURIComponent(url.pathname.slice("/api/v1/properties/".length)), env);
    } catch {
      // Avoid returning raw database or payload details to clients or logs.
      return json({ error: "service_unavailable" }, 503);
    }
    if (!url.pathname.startsWith("/api/") && env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "not_found" }, 404);
  },
};
