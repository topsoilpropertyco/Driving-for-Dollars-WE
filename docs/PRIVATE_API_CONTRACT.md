# Private API contract

`household_api.py` is a local WSGI contract only. It has no server startup
code, Cloudflare configuration, production credential, CORS policy, or public
deployment.

## Endpoints

- `GET /health` reports only synthetic local status.
- `POST /v1/actions` accepts a non-empty batch of validated household actions
  and responds with accepted versus already-seen event IDs.
- `GET /v1/properties/{identity}` returns one property's private current summary
  and append-only household timeline.

The local test bearer is intentionally a test harness device only. Production
must not accept it. Cloudflare Access will authenticate the two approved email
addresses at the edge; the Worker must verify its signed Access assertion before
it routes to private storage.

## Security invariants

- All private endpoints fail closed without authentication.
- Unknown fields, malformed JSON, oversized requests, and invalid actions are
  rejected without persisting any part of a batch.
- No endpoint logs a property, owner, note, access token, or track coordinate.
- Production API responses are private and must include no permissive CORS
  policy. The single app origin is allow-listed deliberately.

## Not authorized yet

No HTTP listener, public endpoint, Cloudflare account, database, bucket, or
real input exists. Provisioning those requires the hosting approval described
in the master plan.
