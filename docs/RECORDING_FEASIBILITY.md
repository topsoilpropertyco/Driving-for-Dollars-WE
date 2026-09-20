# Automatic Recording Feasibility

## Required household behavior

The recording workflow must feel like a simple activity recorder:

1. Open a recorder and tap **Start**.
2. Drive normally, including while the phone is locked or the map app is open.
3. Tap **Stop**.
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
acknowledge accepted events, and support queued retry. Stopping must explicitly
close a session; points received afterward require a new session or review.

## Candidate options

- A native recorder with a secure HTTPS endpoint, such as OwnTracks in its
  frequent movement mode.
- A native tracker/server pair such as Traccar, only if its hosted/self-hosted
  setup remains acceptable after a privacy and cost review.
- A purpose-built native companion, only if the existing clients fail the pilot.

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

- [ ] Both phones can start and stop in under ten seconds.
- [ ] A 30-minute residential drive records after screen lock.
- [ ] Switching between navigation and the home-search app does not stop it.
- [ ] A temporary connectivity loss queues and later delivers points once.
- [ ] Stop prevents subsequent location delivery.
- [ ] A completed session appears as one session, with no duplicate points.
- [ ] Coverage has enough points to distinguish nearby parallel streets.
- [ ] Battery consumption is acceptable for a two-hour drive.
- [ ] No location endpoint, credentials, or recordings are exposed publicly.

## Approval gate

Running the pilot requires approval to install/configure a candidate recorder
and connect it to a new protected endpoint. This repository currently contains
only the integration contract and synthetic UX state; it does not connect to
any device or GPS service.
