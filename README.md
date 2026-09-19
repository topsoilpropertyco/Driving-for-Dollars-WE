# Grosse Pointe Driving Coverage Tracker

Seth and Claire are hunting their next primary home by driving **100% of the
streets** in the five Grosse Pointes, Michigan. Each drive is recorded as a
private Strava "Ride" activity. This tool syncs both Strava accounts, computes
street coverage per city, and renders a static HTML dashboard with a
Seth-vs-Claire leaderboard.

**It runs itself:** a GitHub Actions workflow syncs Strava every hour and
deploys the dashboard to GitHub Pages. Public repos get unlimited Actions
minutes, so the whole thing costs nothing and spends none of Seth's Muse
usage. No web server needed — the dashboard is a single self-contained HTML
file (Leaflet via CDN).

**Privacy model (important):** the public repo and public dashboard never
contain raw GPS history. Per-drive GPS tracks live only in the Actions cache
(never committed); the deployed dashboard is built with `PUBLIC_BUILD=1`,
which strips the per-driver track layers and publishes only aggregate stats,
coverage polygons, undriven streets, and start-here pins. Strava credentials
live only in GitHub repo secrets.

## The five cities

Tracked closest-to-Detroit first (south → north), which is also the display
order in the dashboard:

1. ★ Grosse Pointe Park (borders Detroit directly)
2. Grosse Pointe (city)
3. ★ Grosse Pointe Farms
4. Grosse Pointe Shores
5. ★ Grosse Pointe Woods (up at 8 Mile)

★ marks Henry's priority-interest cities. All five are tracked.

## Setup (~15 minutes, one time)

### 1. Create one Strava API app (covers both athletes)

1. Go to https://www.strava.com/settings/api and create an application.
2. Set the **Authorization Callback Domain** to `localhost`.
3. Note the **Client ID** (not secret — it appears in the OAuth URL, safe to
   share) and the **Client Secret** (never share in chat; it goes straight
   into a GitHub repo secret).

### 2. Authorize both athletes

For each of Seth and Claire:

```bash
export STRAVA_CLIENT_ID=<id> STRAVA_CLIENT_SECRET=<secret>
python strava_auth.py --athlete seth     # Seth opens the URL, authorizes, pastes the redirect URL back
python strava_auth.py --athlete claire   # Claire does the same on her Strava account
```

Tokens land in `tokens/seth.json` / `tokens/claire.json` with `0600`
permissions. (For the GitHub Actions setup, the refresh tokens from these
files go into repo secrets instead — see "GitHub setup" below.)

### 3. Install dependencies and run locally (optional)

```bash
python3 -m venv venv
venv/bin/pip install -r requirements.txt
chmod +x run_all.sh
./run_all.sh
```

This runs: `sync.py` (Strava) → `streets.py` (OSM street networks, cached after
first run) → `coverage.py` → `undriven.py` (undriven segments + start-here
hotspots) → `dashboard.py`. Then open **`dashboard.html`** in your browser.
The local build includes per-driver GPS track layers (blue = Seth, orange =
Claire); the public build (`PUBLIC_BUILD=1`) omits them.

Re-run anytime with `./run_all.sh` — sync is incremental (only new activities
are fetched). To refresh street data: `./run_all.sh --refresh-streets`.

## GitHub setup (hourly auto-sync + Pages dashboard)

1. **Push this repo** to a public GitHub repository (public = unlimited free
   Actions minutes).
2. **Add four repo secrets** (Settings → Secrets and variables → Actions →
   New repository secret):
   - `STRAVA_CLIENT_ID` — from step 1 above
   - `STRAVA_CLIENT_SECRET` — from step 1 above
   - `SETH_REFRESH_TOKEN` — the `refresh_token` from `tokens/seth.json`
   - `CLAIRE_REFRESH_TOKEN` — the `refresh_token` from `tokens/claire.json`
3. **Enable Pages for Actions:** repo Settings → Pages → Build and deployment
   → Source: **GitHub Actions**.
4. The `Sync Strava coverage` workflow (`.github/workflows/sync.yml`) runs
   hourly and on manual dispatch: syncs both athletes, rebuilds the dashboard
   with `PUBLIC_BUILD=1`, persists rotated Strava refresh tokens back to
   secrets (Strava rotates them on every refresh), and deploys to Pages.

Raw GPS tracks are cached between runs with `actions/cache` (`data/tracks`)
and are never committed. `data/activities_index.json` (activity metadata
only — no GPS) is committed so a cache miss can still skip already-synced
activities.

## Strava-side setup (important)

- Record each drive as activity type **Ride** (car speeds look implausible as a "Run").
- Set activity privacy to **Only You**. Private activities sync fine with owner
  tokens, and nobody can see or flag your drives.
- One shared Strava API app covers both athletes — each person authorizes once.

## How coverage is computed

- Street networks and building footprints come from OpenStreetMap via the
  main OSM API (`api.openstreetmap.org`): per-city map tiles (recursive
  quad-split under the API's node limit) for streets/buildings, and
  `/relation/<id>/full` for the exact administrative boundary. (Overpass was
  the original plan, but its chunked responses were intermittently truncated
  by this network's egress proxy; the main API proved fast and reliable.)
- Only real drivable road classes (motorway → living_street); streets are
  clipped to the city boundary polygon.
- Building footprints come from OSM `building=*` ways and relations, per
  city area, cached in `data/buildings/` as centroid points.
- Everything is projected to UTM 16N (EPSG:26916) for meter-accurate math.
- Each track is buffered by `buffer_meters` (30 m default, in `config.yaml`);
  a street counts as "driven" if it intersects the buffered tracks.
- **Houses driven by (approximate):** each building footprint is reduced to its
  centroid; a building counts as "passed" if its centroid falls within 40 m of
  any track. This is an approximation: OSM building data is
  community-mapped and **coverage varies wildly by city** — as of Sep 2026,
  Grosse Pointe Shores had only ~55 mapped buildings and Grosse Pointe (city)
  ~653, versus ~5,100 for Grosse Pointe Park, so the houses metric
  understates reality in the sparsely mapped cities. Large multi-part
  buildings (relations) use an averaged centroid. Good enough for a vanity
  metric, not a census.
- `data/coverage.json` holds per-city totals, combined + per-driver
  percentages, km remaining, houses passed, per-city session counts, and the
  leaderboard.

### Street kilometers per city (fetched Sep 18, 2026)

| City | Street km | Buildings mapped |
|---|---|---|
| ★ Grosse Pointe Park | 108.45 | 5,109 |
| Grosse Pointe | 55.94 | 653 |
| ★ Grosse Pointe Farms | 104.01 | 1,845 |
| Grosse Pointe Shores | 45.68 | 55 |
| ★ Grosse Pointe Woods | 126.12 | 4,685 |
| **Total** | **440.20** | **12,347** |

## The dashboard

`dashboard.html` is self-contained (all data inlined; Leaflet + map tiles via
CDN, so it needs internet when opened). It shows:

- **Header cards:** overall street coverage %, driving sessions (Seth vs
  Claire), miles driven (Seth vs Claire), approximate houses driven by.
- **Interactive map:** city polygons colored red→yellow→green by coverage;
  per-city boundary layers with toggles; click a city for its stats (coverage
  %, km driven, houses passed, sessions). The local build also shows
  per-driver GPS track layers (blue = Seth, orange = Claire); the public
  Pages build omits them for privacy.
- **Sidebar:** the five cities in Detroit-first order with progress bars (★ =
  priority cities), a **Where to drive next** panel (see below), then the
  Seth-vs-Claire leaderboard.

### Where to drive next

- **Undriven streets layer** (on by default, toggleable in the layer control):
  every street segment neither of you has driven yet is drawn as a glowing red
  line with a white casing. Tap any glowing segment for its street name and
  length. As you sync new drives, the glow disappears from streets you've
  covered.
- **📍 Locate me** (top-left map button): shows your live position as a
  pulsing blue dot via `navigator.geolocation.watchPosition`. Tap again to
  stop tracking. Tap **🧭** to toggle follow mode, which keeps the map
  centered on you while you drive. If location is denied or unavailable, a
  small notice appears and the rest of the map keeps working.
- **"Start here" buttons** (one per city, Detroit-first order): drops a pin on
  the best place to begin your next drive and tells you something like
  *"Start near the corner of Vernor Highway and Buckingham Road"* (real OSM
  street names; falls back to a single street, then coordinates), plus a
  **Navigate in Google Maps** link that opens turn-by-turn directions to the
  pin. If you've tapped 📍 Locate me, it picks the nearest big undriven patch
  to your position and says so; otherwise it picks the largest undriven patch
  in that city. If a city is fully driven, the button says so.

### Using it on your phone while driving

1. Open the GitHub Pages dashboard URL (it re-syncs every hour on its own).
2. Tap **📍 Locate me** (allow location), then **🧭** for follow mode.
3. The glowing red streets are what's left to drive — just follow the glow.
4. Before a session, tap **Start here** for the city you're targeting, then
   **Navigate in Google Maps** to drive to the starting corner.
5. Record the drive in Strava as usual (Ride, Only You). Next hourly sync,
   the glowing streets you covered disappear from the map.

## Files

| File | What it does |
|---|---|
| `config.yaml` | Cities, buffer, paths (no secrets; client ID via `STRAVA_CLIENT_ID` env) |
| `strava_auth.py` | Manual OAuth flow + `refresh()` helper; tokens → `tokens/*.json` locally or `<ATHLETE>_REFRESH_TOKEN` env in CI |
| `sync.py` | Incremental Strava sync (Rides only, GPS streams cached in `data/tracks/`) |
| `streets.py` | OSM street networks + boundaries per city (cached in `data/`) |
| `coverage.py` | Coverage math → `data/coverage.json` |
| `undriven.py` | Undriven segments → `data/undriven/*.geojson`; start-here hotspots → `data/starthere.json` |
| `dashboard.py` | Renders self-contained `dashboard.html` (Leaflet via CDN); `PUBLIC_BUILD=1` strips GPS track layers |
| `gen_sample_tracks.py` | Test helper: synthetic tracks on real streets |
| `run_all.sh` | Runs the whole pipeline locally |
| `.github/workflows/sync.yml` | Hourly Strava sync → rebuild → Pages deploy; persists rotated refresh tokens |
