# Automatic Recording Feasibility

## Required household behavior

The recording workflow must feel like a simple activity recorder:

1. Open Traccar Client and turn **Continuous tracking** on.
2. Drive normally, including while the phone is locked or the map app is open.
3. Turn **Continuous tracking** off after parking.
4. The recording is automatically delivered to the household app.
5. The app validates and processes it without a GPX export chore.

Manual GPX upload remains an emergency recovery path only.

## Candidate adapter contract

The application will accept a provider-neutral location event containing:

```text
device identity, event time, latitude, longitude, horizontal accuracy,
optional speed/course, session identity, and an idempotency key
```

The production receiver must authenticate the device, reject replayed or
malformed events, store private locations separately from public results,
acknowledge accepted events, and support queued retry. Turning tracking off
must end delivery; points received afterward require a new session or review.

## Selected pilot: Traccar Client

The household approved a bounded **Traccar Client** pilot on 2026-09-20. The
pilot uses a dedicated, write-only Cloudflare Worker that accepts the standard
OsmAnd/Traccar location fields. It is deliberately separate from the
Cloudflare-Access-protected household application: a native tracker cannot
complete browser email authentication on every location update.

Each private household session can create one random device identifier and one
random 256-bit device credential. Only a SHA-256 hash is stored in D1. The
credential appears only in the signed-in setup screen, is never committed or
logged, and can be revoked by setting `revoked_at` before any future pilot.
The recorder ingress has no list, map, export, or point-read endpoint.

The pilot is **not** a production data launch: no property import, public
dashboard update, or street-coverage replacement is performed by the recorder
endpoint. The first points remain private in D1 for pilot validation only.

### Verified first field test

On 2026-09-21, one household iPhone completed the bounded field test: private
setup, an active short drive with the phone locked, and a Stop verification.
The service received the expected batch of post-test points and then received
no further points after tracking was switched off. Validation used aggregate
counts and timestamps only; no route or coordinate was reviewed. An offline
retry test is still required before the pilot can be called complete.

## Alternatives considered

- OwnTracks with a secure HTTPS endpoint: kept as the fallback if Traccar does
  not meet the locked-screen test.
- A purpose-built native companion: deferred unless both mature native clients
  fail the pilot.

No candidate is selected or connected yet. The web app itself is not the
background recorder.

## Current repository safety gate

Private Strava synchronization is disabled by default. `sync.py` exits before
loading configuration or contacting Strava unless the caller explicitly sets
`ALLOW_PRIVATE_STRAVA_SYNC=1`. `run_all.sh` likewise skips sync unless called
with `--sync-private`; it never installs packages automatically. Sync writes
private caches and its activity index with atomic replacement, and routine
status output does not print activity names, identifiers, locations, tokens,
or response bodies.

## Pilot acceptance checklist

- [ ] Both phones can turn Continuous tracking on and off in under ten seconds.
- [ ] A 30-minute residential drive records after screen lock.
- [ ] Switching between navigation and the home-search app does not stop it.
- [ ] A temporary connectivity loss queues and later delivers points once.
- [ ] Turning Continuous tracking off prevents subsequent location delivery.
- [x] A completed session appears as one session, with no duplicate points (verified on 2026-09-21; the short drive was grouped separately from the earlier stationary test).
- [ ] Coverage has enough points to distinguish nearby parallel streets.
- [ ] Battery consumption is acceptable for a two-hour drive.
- [ ] No location endpoint, credentials, or recordings are exposed publicly.

## Approval gate

The pilot is approved. It requires a household member to install Traccar Client
on one iPhone and complete the private in-app setup. The result determines
whether Traccar becomes the production recorder or is rejected in favor of the
fallback; no raw GPS is to be copied into issue text, Git, CI, chat, or a
public dashboard.
