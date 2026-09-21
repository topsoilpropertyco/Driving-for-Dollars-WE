// Public machine-to-machine ingress for the approved recorder pilot.
// It intentionally exposes no read route and accepts only a valid per-device
// secret. The private household app stays behind Cloudflare Access.

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 10 * 60 * 1000;
const DEVICE_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;

function response(status) {
  return new Response(status === 200 ? "OK" : "", {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}

function finite(value, lower, upper) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= lower && parsed <= upper ? parsed : null;
}

function recordedAt(value) {
  if (!value) return null;
  const string = String(value).trim();
  const milliseconds = /^\d{10,13}$/.test(string)
    ? Number(string) * (string.length === 10 ? 1000 : 1)
    : Date.parse(string);
  if (!Number.isFinite(milliseconds)) return null;
  const now = Date.now();
  if (milliseconds < now - MAX_AGE_MS || milliseconds > now + MAX_FUTURE_MS) return null;
  return new Date(milliseconds).toISOString();
}

async function tokenHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function optionalNumber(value, lower, upper) {
  if (value === null || value === "") return null;
  return finite(value, lower, upper);
}

async function ingest(request, env) {
  const url = new URL(request.url);
  const params = new URLSearchParams(url.search);
  if (request.method === "POST" && request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    for (const [key, value] of form.entries()) if (typeof value === "string") params.set(key, value);
  }
  const deviceId = (params.get("id") || params.get("deviceid") || "").trim().toLowerCase();
  const token = (params.get("token") || "").trim();
  const latitude = finite(params.get("lat"), -90, 90);
  const longitude = finite(params.get("lon"), -180, 180);
  const time = recordedAt(params.get("timestamp"));
  const accuracy = optionalNumber(params.get("accuracy"), 0, 10_000);
  const speed = optionalNumber(params.get("speed"), 0, 150);
  const bearing = optionalNumber(params.get("bearing") || params.get("heading"), 0, 360);
  if (!DEVICE_ID.test(deviceId) || token.length < 32 || latitude === null || longitude === null || !time
    || (params.has("accuracy") && accuracy === null) || (params.has("speed") && speed === null)
    || ((params.has("bearing") || params.has("heading")) && bearing === null)) return response(400);
  const device = await env.DB.prepare(
    "SELECT token_hash FROM recorder_devices WHERE device_id = ? AND revoked_at IS NULL"
  ).bind(deviceId).first();
  if (!device || device.token_hash !== await tokenHash(token)) return response(401);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO recorder_points (device_id, recorded_at, latitude, longitude, accuracy_meters, speed_mps, bearing_degrees, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(deviceId, time, latitude, longitude, accuracy, speed, bearing, new Date().toISOString()).run();
  return response(200);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/") return await ingest(request, env);
      return response(404);
    } catch {
      // Do not log or return location/query details.
      return response(503);
    }
  },
};
