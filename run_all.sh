#!/bin/bash
# Full pipeline. Private Strava sync is deliberately opt-in.
set -e
cd "$(dirname "$0")"

# A caller chooses setup explicitly; this script never installs packages.
if [ ! -x "venv/bin/python" ]; then
  echo "Missing venv/bin/python. Set up dependencies separately, then re-run."
  exit 2
fi
PY="venv/bin/python"

SYNC_PRIVATE=0
REFRESH_STREETS=0
for arg in "$@"; do
  case "$arg" in
    --sync-private) SYNC_PRIVATE=1 ;;
    --refresh-streets) REFRESH_STREETS=1 ;;
    *) echo "Unknown option: $arg"; exit 2 ;;
  esac
done

if [ "$SYNC_PRIVATE" -eq 1 ]; then
  echo "=== 1/5 private Strava sync ==="
  ALLOW_PRIVATE_STRAVA_SYNC=1 $PY sync.py
else
  echo "=== 1/5 private Strava sync skipped (use --sync-private after approval) ==="
fi

echo "=== 2/5 streets.py (OSM street networks, cached) ==="
if [ "$REFRESH_STREETS" -eq 1 ]; then
  $PY streets.py --refresh-streets
else
  $PY streets.py
fi

echo "=== 3/5 coverage.py ==="
$PY coverage.py

echo "=== 4/5 undriven.py (undriven segments + start-here hotspots) ==="
$PY undriven.py

echo "=== 5/5 dashboard.py ==="
$PY dashboard.py

echo "Done. Open dashboard.html in your browser."
