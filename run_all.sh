#!/bin/bash
# Full pipeline: sync Strava -> streets (cached) -> coverage -> undriven -> dashboard
set -e
cd "$(dirname "$0")"

# Always use the project venv (has requests, shapely, pyproj, pyyaml).
if [ ! -x "venv/bin/python" ]; then
  echo "Creating venv and installing requirements..."
  python3 -m venv venv
  venv/bin/pip install -q -r requirements.txt
fi
PY="venv/bin/python"

echo "=== 1/5 sync.py (Strava) ==="
$PY sync.py

echo "=== 2/5 streets.py (OSM street networks, cached) ==="
if [ "$1" == "--refresh-streets" ]; then
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
