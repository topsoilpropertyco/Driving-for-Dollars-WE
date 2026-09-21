import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";

class FakeRouteD1 {
  prepare(sql) {
    assert.match(sql, /FROM recorder_points p JOIN recorder_devices d/);
    return {
      bind: email => {
        assert.equal(email, "seth@example.test");
        return {
          all: async () => ({ results: [
            { recorded_at: "2026-09-20T10:00:00Z", latitude: 42.38, longitude: -82.91 },
            { recorded_at: "2026-09-20T10:01:00Z", latitude: 42.381, longitude: -82.911 },
            { recorded_at: "2026-09-20T10:30:00Z", latitude: 42.39, longitude: -82.92 },
            { recorded_at: "2026-09-20T10:31:00Z", latitude: 42.391, longitude: -82.921 },
          ].reverse() }),
        };
      },
    };
  }
}

const env = { DB: new FakeRouteD1(), ALLOWED_EMAILS: "seth@example.test" };
const response = await worker.fetch(new Request("https://private.example/api/v1/recorders/latest-route", { headers: { "Cf-Access-Authenticated-User-Email": "seth@example.test" } }), env);
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), {
  session_id: "2026-09-20T10:30:00Z",
  point_count: 2,
  started_at: "2026-09-20T10:30:00Z",
  ended_at: "2026-09-20T10:31:00Z",
  sampled_distance_meters: 138,
  largest_gap_meters: 138,
  duration_seconds: 60,
  coordinates: [[-82.92, 42.39], [-82.921, 42.391]],
});

const sessions = await worker.fetch(new Request("https://private.example/api/v1/recorders/sessions", { headers: { "Cf-Access-Authenticated-User-Email": "seth@example.test" } }), env);
assert.equal(sessions.status, 200);
assert.deepEqual(await sessions.json(), { sessions: [
  { session_id: "2026-09-20T10:30:00Z", point_count: 2, started_at: "2026-09-20T10:30:00Z", ended_at: "2026-09-20T10:31:00Z", sampled_distance_meters: 138, largest_gap_meters: 138, duration_seconds: 60 },
  { session_id: "2026-09-20T10:00:00Z", point_count: 2, started_at: "2026-09-20T10:00:00Z", ended_at: "2026-09-20T10:01:00Z", sampled_distance_meters: 138, largest_gap_meters: 138, duration_seconds: 60 },
] });

const olderRoute = await worker.fetch(new Request("https://private.example/api/v1/recorders/latest-route?session=2026-09-20T10%3A00%3A00Z", { headers: { "Cf-Access-Authenticated-User-Email": "seth@example.test" } }), env);
assert.deepEqual(await olderRoute.json(), {
  session_id: "2026-09-20T10:00:00Z",
  point_count: 2,
  started_at: "2026-09-20T10:00:00Z",
  ended_at: "2026-09-20T10:01:00Z",
  sampled_distance_meters: 138,
  largest_gap_meters: 138,
  duration_seconds: 60,
  coordinates: [[-82.91, 42.38], [-82.911, 42.381]],
});

const blocked = await worker.fetch(new Request("https://private.example/api/v1/recorders/latest-route"), env);
assert.equal(blocked.status, 401);

console.log("recorder route contract: passed");
