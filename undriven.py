#!/usr/bin/env python3
"""Compute undriven street segments per city, and "start here" hotspots.

Takes each city's street network (lat/lon LineStrings with OSM name tags,
from data/streets/) and subtracts the combined track buffer (same
buffer_meters coverage.py uses). Writes:

  data/undriven/<slug>.geojson  — undriven LineString segments in lat/lon,
                                  with name/highway/length_m properties
  data/starthere.json           — per city, the top undriven hotspots: the
                                  densest 400 m grid cells of undriven street
                                  midpoints. Each hotspot: pin lat/lon
                                  (midpoint of the longest member segment, so
                                  the pin sits ON an undriven street), total
                                  undriven km, top street names
"""
import glob
import json
import os

import yaml
from pyproj import Transformer
from shapely.geometry import LineString
from shapely.ops import unary_union

from road_network import canonical_feature_parts, line_parts

BASE = os.path.dirname(os.path.abspath(__file__))
FWD = Transformer.from_crs("EPSG:4326", "EPSG:26916", always_xy=True)
INV = Transformer.from_crs("EPSG:26916", "EPSG:4326", always_xy=True)

MIN_SEG_M = 10.0      # drop tiny slivers left at buffer edges
GRID_M = 400.0        # hotspot cell size (meters); densest cells = best start areas
TOP_HOTSPOTS = 8      # hotspots kept per city (dashboard picks nearest/largest)


def slug(name):
    return name.lower().replace(" ", "-")


def load_track_lines(cfg):
    """All synced tracks as UTM LineStrings (any athlete)."""
    lines = []
    for athlete in cfg["strava"]["athletes"]:
        for path in glob.glob(os.path.join(BASE, cfg["paths"]["tracks_dir"], f"{athlete}_*.json")):
            with open(path) as f:
                t = json.load(f)
            ll = t.get("latlng") or []
            if len(ll) >= 2:
                lines.append(LineString([FWD.transform(lon, lat) for lat, lon in ll]))
    return lines


def undriven_segments(street_feats, combined_buf):
    """Return [(utm LineString, name, highway)] of street parts outside the buffer."""
    segs = []
    feature_lines = []
    for ft in street_feats:
        coords = ft["geometry"]["coordinates"]  # [lon, lat]
        if len(coords) < 2:
            continue
        line = LineString([FWD.transform(lon, lat) for lon, lat in coords])
        feature_lines.append((line, ft.get("properties", {})))
    for road in canonical_feature_parts(feature_lines):
        diff = road.line if combined_buf is None else road.line.difference(combined_buf)
        name = road.properties.get("name", "") or ""
        hw = road.properties.get("highway", "") or ""
        for p in line_parts(diff):
            if p.length >= MIN_SEG_M:
                segs.append((p, name, hw))
    return segs


def hotspot_cells(segs):
    """Densest grid cells of undriven street midpoints.

    Each cell's score = total undriven km of segments whose midpoint falls in
    it. Returns up to TOP_HOTSPOTS dicts sorted by km desc:
      {lat, lon, km, streets:[top 2 names]} — lat/lon is the midpoint of the
      longest member segment, so the pin lands on an undriven street.
    """
    cells = {}
    for i, (p, _, _) in enumerate(segs):
        mid = p.interpolate(p.length / 2.0)
        cells.setdefault((int(mid.x // GRID_M), int(mid.y // GRID_M)), []).append(i)

    hotspots = []
    for idxs in cells.values():
        total = sum(segs[i][0].length for i in idxs)
        byname = {}
        for i in idxs:
            nm = segs[i][1]
            if nm:
                byname[nm] = byname.get(nm, 0) + segs[i][0].length
        top_names = [nm for nm, _ in sorted(byname.items(), key=lambda kv: -kv[1])[:2]]
        longest = max((segs[i][0] for i in idxs), key=lambda g: g.length)
        mid = longest.interpolate(longest.length / 2.0)
        lon, lat = INV.transform(mid.x, mid.y)
        hotspots.append({
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            "km": round(total / 1000.0, 2),
            "streets": top_names,
        })
    hotspots.sort(key=lambda c: -c["km"])
    return hotspots[:TOP_HOTSPOTS]


def main():
    cfg = yaml.safe_load(open(os.path.join(BASE, "config.yaml")))
    buf_m = cfg["buffer_meters"]
    undir = os.path.join(BASE, cfg["paths"]["undriven_dir"])
    os.makedirs(undir, exist_ok=True)

    track_lines = load_track_lines(cfg)
    combined_buf = unary_union([ln.buffer(buf_m) for ln in track_lines]) if track_lines else None
    print(f"track buffer: {len(track_lines)} tracks, {buf_m} m")

    starthere = {}
    for city in cfg["cities"]:
        s = slug(city)
        sp = os.path.join(BASE, cfg["paths"]["streets_dir"], f"{s}.geojson")
        feats = json.load(open(sp))["features"]

        segs = undriven_segments(feats, combined_buf)
        out_feats = []
        for p, name, hw in segs:
            ll = [INV.transform(x, y) for x, y in p.coords]  # (lon, lat)
            out_feats.append({
                "type": "Feature",
                "properties": {"name": name, "highway": hw,
                               "length_m": round(p.length, 1)},
                "geometry": {"type": "LineString",
                             "coordinates": [[round(lon, 5), round(lat, 5)] for lon, lat in ll]},
            })
        with open(os.path.join(undir, f"{s}.geojson"), "w") as f:
            json.dump({"type": "FeatureCollection", "features": out_feats}, f)

        clusters = hotspot_cells(segs)
        starthere[city] = clusters
        undriven_km = sum(p.length for p, _, _ in segs) / 1000.0
        named = sum(1 for _, nm, _ in segs if nm)
        print(f"  {city}: {len(out_feats)} undriven segments, "
              f"{undriven_km:.1f} km ({named} named), {len(clusters)} hotspots")

    shp = os.path.join(BASE, cfg["paths"]["starthere"])
    with open(shp, "w") as f:
        json.dump(starthere, f, indent=2)
    print(f"wrote {shp}")


if __name__ == "__main__":
    main()
