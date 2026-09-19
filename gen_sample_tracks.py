#!/usr/bin/env python3
"""Generate SYNTHETIC drive tracks from real street geometry (testing only).

Random-walks along actual OSM street points inside Grosse Pointe Park and
Grosse Pointe Woods, so the tracks lie on real streets. Writes cache files in
the exact format sync.py uses, plus activities_index.json entries.
3 tracks -> seth, 3 tracks -> claire.
"""
import json
import os
import random

import yaml
from pyproj import Transformer

BASE = os.path.dirname(os.path.abspath(__file__))
FWD = Transformer.from_crs("EPSG:4326", "EPSG:26916", always_xy=True)
BACK = Transformer.from_crs("EPSG:26916", "EPSG:4326", always_xy=True)
random.seed(42)


def slug(name):
    return name.lower().replace(" ", "-")


def load_utm_points(city_slug):
    cfg = yaml.safe_load(open(os.path.join(BASE, "config.yaml")))
    gj = json.load(open(os.path.join(BASE, cfg["paths"]["streets_dir"], f"{city_slug}.geojson")))
    pts = []
    for ft in gj["features"]:
        for lon, lat in ft["geometry"]["coordinates"]:
            pts.append(FWD.transform(lon, lat))
    return pts


def grid_index(pts, cell=100.0):
    g = {}
    for i, (x, y) in enumerate(pts):
        g.setdefault((int(x // cell), int(y // cell)), []).append(i)
    return g


def random_walk(pts, g, n_points=70, step_max=300.0):
    idx = random.randrange(len(pts))
    path = [pts[idx]]
    used = {idx}
    for _ in range(n_points - 1):
        x, y = path[-1]
        cx, cy = int(x // 100.0), int(y // 100.0)
        cands = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in g.get((cx + dx, cy + dy), []):
                    if i in used:
                        continue
                    px, py = pts[i]
                    d = ((px - x) ** 2 + (py - y) ** 2) ** 0.5
                    if 5 < d < step_max:
                        cands.append(i)
        if not cands:
            break
        idx = random.choice(cands)
        used.add(idx)
        path.append(pts[idx])
    return path


def main():
    cfg = yaml.safe_load(open(os.path.join(BASE, "config.yaml")))
    tracks_dir = os.path.join(BASE, cfg["paths"]["tracks_dir"])
    os.makedirs(tracks_dir, exist_ok=True)

    plan = [
        ("seth", 900001, "Grosse Pointe Park", "2026-09-10T09:12:00"),
        ("seth", 900002, "Grosse Pointe Woods", "2026-09-11T10:05:00"),
        ("seth", 900003, "Grosse Pointe Park", "2026-09-13T08:44:00"),
        ("claire", 900004, "Grosse Pointe Woods", "2026-09-12T11:30:00"),
        ("claire", 900005, "Grosse Pointe Park", "2026-09-14T09:02:00"),
        ("claire", 900006, "Grosse Pointe Woods", "2026-09-15T13:20:00"),
    ]
    cache = {}
    index = []
    for athlete, aid, city, date in plan:
        s = slug(city)
        if s not in cache:
            pts = load_utm_points(s)
            cache[s] = (pts, grid_index(pts))
        pts, g = cache[s]
        walk = random_walk(pts, g)
        latlng = []
        dist_m = 0.0
        for i, (x, y) in enumerate(walk):
            lon, lat = BACK.transform(x, y)
            latlng.append([round(lat, 6), round(lon, 6)])
            if i:
                px, py = walk[i - 1]
                dist_m += ((x - px) ** 2 + (y - py) ** 2) ** 0.5
        name = f"Test drive — {city}"
        with open(os.path.join(tracks_dir, f"{athlete}_{aid}.json"), "w") as f:
            json.dump({"id": aid, "athlete": athlete, "name": name, "date": date,
                       "distance_m": round(dist_m, 1), "latlng": latlng}, f)
        index.append({"id": aid, "athlete": athlete, "name": name, "date": date,
                      "distance_m": round(dist_m, 1)})
        print(f"[{athlete}] synthetic track {aid}: {len(latlng)} pts, {dist_m/1000:.2f} km in {city}")

    with open(os.path.join(BASE, cfg["paths"]["activities_index"]), "w") as f:
        json.dump(index, f, indent=2)
    print(f"wrote {len(index)} index entries")


if __name__ == "__main__":
    main()
