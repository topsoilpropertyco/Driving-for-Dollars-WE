import assert from "node:assert/strict";
import worker from "../cloudflare/worker.js";

const headers = { "Cf-Access-Authenticated-User-Email": "home@example.test" };
const session = "123e4567-e89b-4123-a456-426614174000";
const unavailable = await worker.fetch(new Request(`https://private.example.test/api/v1/address-autocomplete?q=1404%20Ni&session=${session}`, { headers }), { ALLOWED_EMAILS: "home@example.test" });
assert.equal(unavailable.status, 503);

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes(":autocomplete")) {
    assert.equal(options.method, "POST");
    assert.equal(JSON.parse(options.body).sessionToken, session);
    return Response.json({ suggestions: [{ placePrediction: { placeId: "synthetic-place", text: { text: "1404 Nicollet Place, Detroit, MI 48207, USA" } } }] });
  }
  assert.match(String(url), /synthetic-place/);
  return Response.json({ formattedAddress: "1404 Nicollet Place, Detroit, MI 48207, USA", location: { latitude: 42.33, longitude: -83.04 } });
};
try {
  const env = { ALLOWED_EMAILS: "home@example.test", GOOGLE_PLACES_API_KEY: "synthetic-key" };
  const suggestions = await worker.fetch(new Request(`https://private.example.test/api/v1/address-autocomplete?q=1404%20Ni&session=${session}`, { headers }), env);
  assert.equal(suggestions.status, 200);
  assert.deepEqual((await suggestions.json()).suggestions, [{ place_id: "synthetic-place", address: "1404 Nicollet Place, Detroit, MI 48207, USA" }]);
  const selected = await worker.fetch(new Request(`https://private.example.test/api/v1/address-place?place_id=synthetic-place&session=${session}`, { headers }), env);
  assert.equal(selected.status, 200);
  assert.deepEqual(await selected.json(), { address: "1404 Nicollet Place, Detroit, MI 48207, USA", latitude: 42.33, longitude: -83.04 });
} finally { globalThis.fetch = nativeFetch; }

console.log("places autocomplete contract: passed");
