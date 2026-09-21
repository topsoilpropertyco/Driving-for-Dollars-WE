import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";

class FakeStatusD1 {
  prepare(sql) {
    assert.match(sql, /COUNT\(DISTINCT d\.device_id\)/);
    return {
      bind: email => {
        assert.equal(email, "seth@example.test");
        return { first: async () => ({ active_devices: 1, points_received: 2, latest_received_at: "2026-09-20T12:00:02Z", latest_recorded_at: "2026-09-20T12:00:00Z" }) };
      },
    };
  }
}

const env = { DB: new FakeStatusD1(), ALLOWED_EMAILS: "seth@example.test" };
const allowed = await worker.fetch(new Request("https://private.example/api/v1/recorders/status", { headers: { "Cf-Access-Authenticated-User-Email": "seth@example.test" } }), env);
assert.equal(allowed.status, 200);
assert.deepEqual(await allowed.json(), { active_devices: 1, points_received: 2, latest_received_at: "2026-09-20T12:00:02Z", latest_recorded_at: "2026-09-20T12:00:00Z" });

const blocked = await worker.fetch(new Request("https://private.example/api/v1/recorders/status"), env);
assert.equal(blocked.status, 401);

console.log("recorder status contract: passed");
