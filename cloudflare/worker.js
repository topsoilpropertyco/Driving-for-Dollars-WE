// Private Worker API. Cloudflare Access must protect this route; this code
// additionally restricts authenticated identities to the household allow-list.

const MAX_BODY_BYTES = 100_000;
const STAGES = new Set([
  "no_outreach", "reached_out", "waiting_for_reply", "in_conversation",
  "contractor_offer", "realtor_referral", "closed", "archived",
]);
const KINDS = new Set(["property_saved", "note_added", "stage_changed", "outreach_logged", "property_tagged"]);
const CONDITIONS = new Set(["pristine", "average", "needs_work", "abandoned"]);
const TAG_PREFIX = "five_pointes_private_tag:";
const OPTIONAL_TAG_SCORES = ["home_excitement_score", "neighborhood_excitement_score"];
// This Worker is a single private household deployment. All Cloudflare Access
// allow-listed members share recorder history and derived coverage; raw points
// remain available only through this protected Worker.
const HOUSEHOLD_SCOPE = "household";

function validTagScores(value) {
  if (!value || !CONDITIONS.has(value.condition) || !Number.isInteger(value.score) || value.score < 1 || value.score > 10) return false;
  return OPTIONAL_TAG_SCORES.every(field => !(field in value) || (Number.isInteger(value[field]) && value[field] >= 1 && value[field] <= 10));
}

function validTagLocation(value) {
  const hasLatitude = "latitude" in value, hasLongitude = "longitude" in value;
  return (!hasLatitude && !hasLongitude) || (hasLatitude && hasLongitude && Number.isFinite(value.latitude) && Number.isFinite(value.longitude) && value.latitude >= -90 && value.latitude <= 90 && value.longitude >= -180 && value.longitude <= 180);
}

function privateTag(payload) {
  if (!payload || typeof payload.note !== "string" || !payload.note.startsWith(TAG_PREFIX)) return null;
  try {
    const value = JSON.parse(payload.note.slice(TAG_PREFIX.length));
    if (!validTagScores(value) || !validTagLocation(value) || !Object.keys(value).every(field => ["condition", "score", "latitude", "longitude", ...OPTIONAL_TAG_SCORES].includes(field))) return null;
    return value;
  } catch { return null; }
}
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
    "SELECT COUNT(DISTINCT d.device_id) AS active_devices, SUM(CASE WHEN d.created_by_email = ? THEN 1 ELSE 0 END) AS account_active_devices, COUNT(p.device_id) AS points_received, MAX(p.received_at) AS latest_received_at, MAX(p.recorded_at) AS latest_recorded_at FROM recorder_devices d LEFT JOIN recorder_points p ON p.device_id = d.device_id WHERE d.revoked_at IS NULL"
  ).bind(email).first();
  return json({
    active_devices: Number(row?.active_devices || 0),
    account_active_devices: Number(row?.account_active_devices || 0),
    points_received: Number(row?.points_received || 0),
    latest_received_at: row?.latest_received_at || null,
    latest_recorded_at: row?.latest_recorded_at || null,
  });
}

const ROUTE_SESSION_GAP_MS = 15 * 60 * 1000;

async function recorderRoutePoints(env) {
  const result = await env.DB.prepare(
    "SELECT p.recorded_at, p.latitude, p.longitude, d.device_id FROM recorder_points p JOIN recorder_devices d ON d.device_id = p.device_id WHERE d.revoked_at IS NULL ORDER BY p.recorded_at ASC, d.device_id ASC LIMIT 5000"
  ).bind().all();
  return (result.results || []).filter(row =>
    typeof row.recorded_at === "string" && Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))
  );
}

function recorderSessions(rows) {
  const byDevice = new Map();
  for (const row of rows) {
    if (!byDevice.has(row.device_id)) byDevice.set(row.device_id, []);
    byDevice.get(row.device_id).push(row);
  }
  const sessions = [];
  for (const deviceRows of byDevice.values()) {
    deviceRows.sort((first, second) => Date.parse(first.recorded_at) - Date.parse(second.recorded_at));
    let current = [];
    for (const row of deviceRows) {
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
  }
  return sessions.sort((first, second) => Date.parse(first[0].recorded_at) - Date.parse(second[0].recorded_at));
}

function recorderSessionId(session) {
  const text = `${session[0]?.device_id || ""}:${session[0]?.recorded_at || ""}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16_777_619); }
  return `drive-${(hash >>> 0).toString(36)}-${Date.parse(session[0]?.recorded_at || "").toString(36)}`;
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
    session_id: session.length ? recorderSessionId(session) : null,
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

async function latestRecorderRoute(env, requestedSessionId = null) {
  // Coordinates are returned only to an authenticated household member. Device
  // identities never leave this Worker, including when two phones overlap.
  const sessions = recorderSessions(await recorderRoutePoints(env));
  const session = requestedSessionId ? sessions.find(candidate => recorderSessionId(candidate) === requestedSessionId) : sessions.at(-1);
  return json(routePayload(session || []));
}

async function recorderSessionList(env) {
  const sessions = recorderSessions(await recorderRoutePoints(env));
  return json({ sessions: sessions.slice(-20).reverse().map(session => {
    const payload = routePayload(session);
    return { session_id: payload.session_id, point_count: payload.point_count, started_at: payload.started_at, ended_at: payload.ended_at, sampled_distance_meters: payload.sampled_distance_meters, largest_gap_meters: payload.largest_gap_meters, duration_seconds: payload.duration_seconds };
  }) });
}

function validCoverageSegment(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9 .:_-]+$/.test(value);
}

function validPlaceSession(value) { return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value); }
function validPlaceId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value); }
async function googlePlaces(request, env, email) {
  const url = new URL(request.url);
  const key = typeof env.GOOGLE_PLACES_API_KEY === "string" ? env.GOOGLE_PLACES_API_KEY : "";
  if (!key) return json({ error: "address_search_unavailable" }, 503);
  const session = url.searchParams.get("session");
  if (!validPlaceSession(session)) return json({ error: "invalid_request" }, 400);
  const input = url.searchParams.get("q")?.trim() || "";
  if (url.pathname === "/api/v1/address-autocomplete") {
    if (input.length < 3 || input.length > 180) return json({ error: "invalid_request" }, 400);
    const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text" },
      body: JSON.stringify({ input, sessionToken: session, includedRegionCodes: ["us"] }),
    });
    if (!response.ok) return json({ error: "address_search_unavailable" }, 503);
    const body = await response.json();
    const suggestions = (body.suggestions || []).flatMap(item => {
      const prediction = item.placePrediction;
      return validPlaceId(prediction?.placeId) && typeof prediction?.text?.text === "string" ? [{ place_id: prediction.placeId, address: prediction.text.text.slice(0, 256) }] : [];
    }).slice(0, 5);
    return json({ suggestions });
  }
  const placeId = url.searchParams.get("place_id");
  if (!validPlaceId(placeId)) return json({ error: "invalid_request" }, 400);
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(session)}`, {
    headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "formattedAddress,location" },
  });
  if (!response.ok) return json({ error: "address_search_unavailable" }, 503);
  const body = await response.json();
  if (typeof body.formattedAddress !== "string" || !Number.isFinite(body.location?.latitude) || !Number.isFinite(body.location?.longitude)) return json({ error: "address_search_unavailable" }, 503);
  return json({ address: body.formattedAddress.slice(0, 256), latitude: body.location.latitude, longitude: body.location.longitude });
}

async function coveragePreview(request, env) {
  if (request.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT segment_id, MAX(last_seen_at) AS last_seen_at FROM coverage_preview_segments GROUP BY segment_id ORDER BY segment_id LIMIT 20001"
    ).bind().all();
    const rows = result.results || [];
    const campaign = rows.find(row => row.segment_id === "__five_pointes_campaign_start__");
    const entries = rows.filter(row => row.segment_id !== "__five_pointes_campaign_start__").map(row => ({ segment_id: row.segment_id, last_seen_at: row.last_seen_at }));
    return json({ segments: entries.map(entry => entry.segment_id), entries, campaign_started_at: campaign?.last_seen_at || null });
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "invalid_request" }, 400); }
  if (!body || typeof body !== "object" || !Object.keys(body).every(field => field === "segments" || field === "start_fresh_campaign") || !Array.isArray(body.segments) || body.segments.length > 20000 || !body.segments.every(validCoverageSegment) || ("start_fresh_campaign" in body && body.start_fresh_campaign !== true)) return json({ error: "invalid_request" }, 400);
  const now = new Date().toISOString();
  const unique = [...new Set(body.segments)];
  const statements = unique.map(segment => env.DB.prepare(
    "INSERT INTO coverage_preview_segments (created_by_email, segment_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(created_by_email, segment_id) DO UPDATE SET last_seen_at = excluded.last_seen_at"
  ).bind(HOUSEHOLD_SCOPE, segment, now, now));
  if (body.start_fresh_campaign) statements.push(env.DB.prepare(
    "INSERT INTO coverage_preview_segments (created_by_email, segment_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(created_by_email, segment_id) DO UPDATE SET last_seen_at = excluded.last_seen_at"
  ).bind(HOUSEHOLD_SCOPE, "__five_pointes_campaign_start__", now, now));
  if (statements.length) await env.DB.batch(statements);
  return json({ stored_segments: unique.length, campaign_started_at: body.start_fresh_campaign ? now : null });
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
  if (value.kind === "property_tagged") return validTagScores(value.payload) && validTagLocation(value.payload) && Object.keys(value.payload).every(field => ["condition", "score", "latitude", "longitude", ...OPTIONAL_TAG_SCORES].includes(field));
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
  let condition = null, score = null, location = null, home_excitement_score = null, neighborhood_excitement_score = null;
  for (const row of rows.results) {
    const payload = JSON.parse(row.payload_json);
    if (row.kind === "stage_changed") stage = payload.stage;
    const tag = row.kind === "note_added" ? privateTag(payload) : null;
    if (row.kind === "note_added" && !tag) notes.push(payload.note);
    if (row.kind === "outreach_logged") outreach_methods.push(payload.method);
    if (row.kind === "property_tagged") {
      condition = payload.condition;
      score = payload.score;
      home_excitement_score = Number.isInteger(payload.home_excitement_score) ? payload.home_excitement_score : home_excitement_score;
      neighborhood_excitement_score = Number.isInteger(payload.neighborhood_excitement_score) ? payload.neighborhood_excitement_score : neighborhood_excitement_score;
      location = Number.isFinite(payload.latitude) && Number.isFinite(payload.longitude) ? [payload.longitude, payload.latitude] : location;
    }
    if (tag) {
      condition = tag.condition;
      score = tag.score;
      home_excitement_score = Number.isInteger(tag.home_excitement_score) ? tag.home_excitement_score : home_excitement_score;
      neighborhood_excitement_score = Number.isInteger(tag.neighborhood_excitement_score) ? tag.neighborhood_excitement_score : neighborhood_excitement_score;
      location = Number.isFinite(tag.latitude) && Number.isFinite(tag.longitude) ? [tag.longitude, tag.latitude] : location;
    }
    timeline.push({ event_id: row.event_id, occurred_at: row.occurred_at, kind: row.kind, payload });
  }
  const summary = { property_identity: identity, saved: timeline.some(item => item.kind === "property_saved"), stage, notes, outreach_methods, condition, score, location, action_count: timeline.length };
  if (home_excitement_score !== null) summary.home_excitement_score = home_excitement_score;
  if (neighborhood_excitement_score !== null) summary.neighborhood_excitement_score = neighborhood_excitement_score;
  return json({ summary, timeline });
}

async function properties(env) {
  // This CRM list contains household-created identifiers and action state only.
  // It does not introduce owner, address, provider, or contact data.
  const rows = await env.DB.prepare(
    "SELECT property_identity, occurred_at, kind, payload_json FROM household_actions ORDER BY property_identity, occurred_at, event_id LIMIT 5000"
  ).bind().all();
  const summaries = new Map();
  for (const row of rows.results || []) {
    const current = summaries.get(row.property_identity) || { property_identity: row.property_identity, saved: false, stage: "no_outreach", condition: null, score: null, location: null, action_count: 0, last_activity_at: row.occurred_at };
    current.saved ||= row.kind === "property_saved";
    current.action_count += 1;
    current.last_activity_at = row.occurred_at;
    if (row.kind === "stage_changed") current.stage = JSON.parse(row.payload_json).stage;
    const payload = JSON.parse(row.payload_json);
    const tag = row.kind === "note_added" ? privateTag(payload) : null;
    if (row.kind === "property_tagged") {
      current.condition = payload.condition;
      current.score = payload.score;
      if (Number.isInteger(payload.home_excitement_score)) current.home_excitement_score = payload.home_excitement_score;
      if (Number.isInteger(payload.neighborhood_excitement_score)) current.neighborhood_excitement_score = payload.neighborhood_excitement_score;
      if (Number.isFinite(payload.latitude) && Number.isFinite(payload.longitude)) current.location = [payload.longitude, payload.latitude];
    }
    if (tag) {
      current.condition = tag.condition;
      current.score = tag.score;
      if (Number.isInteger(tag.home_excitement_score)) current.home_excitement_score = tag.home_excitement_score;
      if (Number.isInteger(tag.neighborhood_excitement_score)) current.neighborhood_excitement_score = tag.neighborhood_excitement_score;
      if (Number.isFinite(tag.latitude) && Number.isFinite(tag.longitude)) current.location = [tag.longitude, tag.latitude];
    }
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
        return latestRecorderRoute(env, sessionId && sessionId.length <= 80 ? sessionId : null);
      }
      if (request.method === "GET" && url.pathname === "/api/v1/recorders/sessions") return recorderSessionList(env);
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/v1/coverage-preview") return coveragePreview(request, env);
      if (request.method === "GET" && (url.pathname === "/api/v1/address-autocomplete" || url.pathname === "/api/v1/address-place")) return googlePlaces(request, env, email);
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
