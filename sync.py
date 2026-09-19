#!/usr/bin/env python3
"""Incrementally sync Strava Ride activities + GPS streams for all athletes.

- Skips athletes with no tokens/<athlete>.json (prints how to authorize).
- Keeps type == "Ride" only; private activities are included via owner tokens.
- Caches each track as data/tracks/<athlete>_<activity_id>.json and keeps
  data/activities_index.json. Already-cached ids are skipped.
- Sleeps ~0.5s between stream fetches; exits with a clear message on 429.
"""
import glob
import json
import os
import sys
import time

import requests

from strava_auth import load_config, load_tokens, refresh

BASE = os.path.dirname(os.path.abspath(__file__))
ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities"


def load_index(path):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return []


def main():
    cfg = load_config()
    paths = cfg["paths"]
    tracks_dir = os.path.join(BASE, paths["tracks_dir"])
    os.makedirs(tracks_dir, exist_ok=True)
    index_path = os.path.join(BASE, paths["activities_index"])
    index = load_index(index_path)
    known = {(e["athlete"], e["id"]) for e in index}

    for athlete in cfg["strava"]["athletes"]:
        tok, _source = load_tokens(athlete)
        if tok is None:
            print(f"[{athlete}] no tokens (tokens/{athlete}.json or "
                  f"{athlete.upper()}_REFRESH_TOKEN env var) — authorize first:")
            print(f"           python strava_auth.py --athlete {athlete}   (skipping)")
            continue
        try:
            token = refresh(athlete)
        except Exception as e:
            print(f"[{athlete}] token refresh failed: {e} (skipping)")
            continue
        headers = {"Authorization": f"Bearer {token}"}
        page, new_count = 1, 0
        while True:
            r = requests.get(
                ACTIVITIES_URL,
                headers=headers,
                params={"per_page": 200, "page": page},
                timeout=30,
            )
            if r.status_code == 429:
                sys.exit(
                    "Strava rate limit hit (429). Wait ~15 minutes and re-run — "
                    "sync is incremental, so already-fetched tracks are safe."
                )
            r.raise_for_status()
            acts = r.json()
            if not acts:
                break
            for a in acts:
                if a.get("type") != "Ride":
                    continue
                aid = a["id"]
                if (athlete, aid) in known:
                    continue
                time.sleep(0.5)  # polite pacing for the streams endpoint
                sr = requests.get(
                    f"https://www.strava.com/api/v3/activities/{aid}/streams",
                    headers=headers,
                    params={"keys": "latlng", "key_by_type": "true"},
                    timeout=30,
                )
                if sr.status_code == 429:
                    sys.exit(
                        "Strava rate limit hit (429) while fetching streams. "
                        "Re-run later; cached tracks are kept."
                    )
                sr.raise_for_status()
                latlng = (sr.json().get("latlng") or {}).get("data") or []
                track = {
                    "id": aid,
                    "athlete": athlete,
                    "name": a.get("name"),
                    "date": a.get("start_date_local"),
                    "distance_m": a.get("distance"),
                    "latlng": latlng,
                }
                with open(os.path.join(tracks_dir, f"{athlete}_{aid}.json"), "w") as f:
                    json.dump(track, f)
                index.append(
                    {
                        "id": aid,
                        "athlete": athlete,
                        "name": a.get("name"),
                        "date": a.get("start_date_local"),
                        "distance_m": a.get("distance"),
                    }
                )
                known.add((athlete, aid))
                new_count += 1
                print(f"[{athlete}] + {a.get('name')} ({len(latlng)} points)")
            if len(acts) < 200:
                break
            page += 1
        print(f"[{athlete}] done: {new_count} new ride(s)")

    with open(index_path, "w") as f:
        json.dump(index, f, indent=2)
    print(f"index: {len(index)} activit(ies) total")


if __name__ == "__main__":
    main()
