import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";

class FakeRouteD1 {
  prepare(sql) {
    assert.match(sql, /FROM recorder_points p JOIN recorder_devices d/);
    assert.match(sql, /d\.device_id/);
    return {
      bind: (...args) => {
        assert.deepEqual(args, []);
        return {
          all: async () => ({ results: [
            // Two phones reporting at the same time must remain two routes.
            { device_id: "pilot-alpha", recorded_at: "2026-09-20T10:00:00Z", latitude: 42.38, longitude: -82.91 },
            { device_id: "pilot-bravo", recorded_at: "2026-09-20T10:00:00Z", latitude: 42.40, longitude: -82.93 },
            { device_id: "pilot-alpha", recorded_at: "2026-09-20T10:01:00Z", latitude: 42.381, longitude: -82.911 },
            { device_id: "pilot-bravo", recorded_at: "2026-09-20T10:01:00Z", latitude: 42.401, longitude: -82.931 },
            { device_id: "pilot-alpha", recorded_at: "2026-09-20T10:30:00Z", latitude: 42.39, longitude: -82.92 },
            { device_id: "pilot-alpha", recorded_at: "2026-09-20T10:31:00Z", latitude: 42.391, longitude: -82.921 },
          ] }),
        };
      },
    };
  }
}

const env = { DB: new FakeRouteD1(), ALLOWED_EMAILS: "seth@example.test,claire@example.test" };
const sethHeaders = { "Cf-Access-Authenticated-User-Email": "seth@example.test" };
const claireHeaders = { "Cf-Access-Authenticated-User-Email": "claire@example.test" };

const sessionsResponse = await worker.fetch(new Request("https://private.example/api/v1/recorders/sessions", { headers: sethHeaders }), env);
assert.equal(sessionsResponse.status, 200);
const sessionsPayload = await sessionsResponse.json();
assert.equal(sessionsPayload.sessions.length, 3);
assert.equal(new Set(sessionsPayload.sessions.map(session => session.session_id)).size, 3);
assert.ok(sessionsPayload.sessions.every(session => /^drive-/.test(session.session_id)));
assert.ok(!JSON.stringify(sessionsPayload).includes("pilot-"));

const simultaneous = sessionsPayload.sessions.filter(session => session.started_at === "2026-09-20T10:00:00Z");
assert.equal(simultaneous.length, 2);
assert.ok(simultaneous.every(session => session.point_count === 2 && session.duration_seconds === 60));

for (const session of simultaneous) {
  const routeResponse = await worker.fetch(new Request(`https://private.example/api/v1/recorders/latest-route?session=${encodeURIComponent(session.session_id)}`, { headers: sethHeaders }), env);
  assert.equal(routeResponse.status, 200);
  const route = await routeResponse.json();
  assert.equal(route.point_count, 2);
  assert.equal(route.coordinates.length, 2);
  assert.ok(route.coordinates.every(([longitude]) => longitude < -82.9));
}

const latestResponse = await worker.fetch(new Request("https://private.example/api/v1/recorders/latest-route", { headers: sethHeaders }), env);
assert.equal(latestResponse.status, 200);
assert.deepEqual(await latestResponse.json(), {
  session_id: sessionsPayload.sessions[0].session_id,
  point_count: 2,
  started_at: "2026-09-20T10:30:00Z",
  ended_at: "2026-09-20T10:31:00Z",
  sampled_distance_meters: 138,
  largest_gap_meters: 138,
  duration_seconds: 60,
  coordinates: [[-82.92, 42.39], [-82.921, 42.391]],
});

const sharedSessions = await worker.fetch(new Request("https://private.example/api/v1/recorders/sessions", { headers: claireHeaders }), env);
assert.equal(sharedSessions.status, 200);
assert.deepEqual(await sharedSessions.json(), sessionsPayload);

const blocked = await worker.fetch(new Request("https://private.example/api/v1/recorders/latest-route"), env);
assert.equal(blocked.status, 401);

console.log("recorder route contract: passed");
