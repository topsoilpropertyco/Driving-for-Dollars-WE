#!/usr/bin/env python3
"""Compute street coverage per city from synced Strava tracks.

Projects everything to EPSG:26916 (UTM 16N). Per city:
  total street length, driven length (streets within buffer_meters of any
  track), combined + per-driver percentages.
Writes data/coverage.json with per-city stats and a Seth-vs-Claire leaderboard.
"""
import datetime
import glob
import json
import os

import yaml
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon
from shapely.ops import unary_union

from artifact_io import write_json_atomically
from road_network import canonical_network

BASE = os.path.dirname(os.path.abspath(__file__))
T = Transformer.from_crs("EPSG:4326", "EPSG:26916", always_xy=True)
KM_TO_MI = 0.621371
HOUSE_BUFFER_M = 40  # "houses driven by": centroid within 40 m of any track


def slug(name):
    return name.lower().replace(" ", "-")


def latlon_to_utm_line(latlng):
    # latlng: [[lat, lon], ...] -> shapely LineString in meters
    return LineString([T.transform(lon, lat) for lat, lon in latlng])


def load_street_lines(slug_):
    cfg = yaml.safe_load(open(os.path.join(BASE, "config.yaml")))
    path = os.path.join(BASE, cfg["paths"]["streets_dir"], f"{slug_}.geojson")
    with open(path) as f:
        gj = json.load(f)
    lines = []
    for ft in gj["features"]:
        coords = ft["geometry"]["coordinates"]  # [lon, lat]
        if len(coords) >= 2:
            lines.append(LineString([T.transform(lon, lat) for lon, lat in coords]))
    return lines


def load_boundary_poly(slug_):
    cfg = yaml.safe_load(open(os.path.join(BASE, "config.yaml")))
    path = os.path.join(BASE, cfg["paths"]["boundaries_dir"], f"{slug_}.geojson")
    with open(path) as f:
        gj = json.load(f)
    polys = []
    for ft in gj["features"]:
        g = ft["geometry"]
        if g["type"] == "MultiPolygon":
            for poly_coords in g["coordinates"]:
                rings = [[T.transform(lon, lat) for lon, lat in ring] for ring in poly_coords]
                polys.append(Polygon(rings[0], rings[1:]))
        elif g["type"] == "Polygon":
            rings = [[T.transform(lon, lat) for lon, lat in ring] for ring in g["coordinates"]]
            polys.append(Polygon(rings[0], rings[1:]))
    return unary_union(polys) if polys else None


def main():
    cfg = yaml.safe_load(open(os.path.join(BASE, "config.yaml")))
    buf_m = cfg["buffer_meters"]
    athletes = cfg["strava"]["athletes"]

    # Load tracks per athlete (UTM LineStrings), keeping (athlete, line) pairs.
    tracks = {}
    track_items = []
    for athlete in athletes:
        lines = []
        for path in glob.glob(os.path.join(BASE, cfg["paths"]["tracks_dir"], f"{athlete}_*.json")):
            with open(path) as f:
                t = json.load(f)
            ll = t.get("latlng") or []
            if len(ll) >= 2:
                line = latlon_to_utm_line(ll)
                lines.append(line)
                track_items.append((athlete, line))
        tracks[athlete] = lines

    buffers = {}
    for athlete, lines in tracks.items():
        buffers[athlete] = unary_union([ln.buffer(buf_m) for ln in lines]) if lines else None
    combined_buf = unary_union([b for b in buffers.values() if b is not None]) \
        if any(buffers.values()) else None

    # Activity index for leaderboard (drive counts, km, last drive date).
    index_path = os.path.join(BASE, cfg["paths"]["activities_index"])
    index = json.load(open(index_path)) if os.path.exists(index_path) else []
    board = {}
    for athlete in athletes:
        mine = [e for e in index if e["athlete"] == athlete]
        dists = [e.get("distance_m") or 0 for e in mine]
        dates = [e.get("date") for e in mine if e.get("date")]
        total_km = sum(dists) / 1000.0
        board[athlete] = {
            "num_drives": len(mine),
            "total_km": round(total_km, 2),
            "total_miles": round(total_km * KM_TO_MI, 1),
            "last_drive_date": max(dates) if dates else None,
        }

    # 40 m buffer around ALL tracks (either driver) for the houses metric.
    house_buf = None
    if combined_buf is not None:
        all_lines = [ln for lines in tracks.values() for ln in lines]
        house_buf = unary_union([ln.buffer(HOUSE_BUFFER_M) for ln in all_lines])

    cities_out = {}
    grand_total_m = grand_driven_m = 0
    grand_buildings = grand_houses = 0
    for city in cfg["cities"]:
        s = slug(city)
        street_lines = load_street_lines(s)
        network = canonical_network(street_lines)
        # Use the unioned network for both numerator and denominator.  This
        # makes duplicated OSM geometries contribute once, while intersections
        # and parallel/divided roads retain their independent line lengths.
        total_m = network.length

        # Sessions touching this city: tracks intersecting the boundary.
        bound_poly = load_boundary_poly(s)
        sess = {a: 0 for a in athletes}
        if bound_poly is not None:
            for athlete, line in track_items:
                if line.intersects(bound_poly):
                    sess[athlete] += 1
        sess["total"] = sum(sess.values())

        per_driver = {}
        for athlete in athletes:
            driven_m = network.intersection(buffers[athlete]).length \
                if (not network.is_empty and buffers[athlete] is not None) else 0.0
            per_driver[athlete] = {
                "driven_km": round(driven_m / 1000.0, 2),
                "pct": round(driven_m / total_m * 100.0, 1) if total_m else 0.0,
                "num_drives": sess[athlete],
            }
        combined_m = network.intersection(combined_buf).length \
            if (not network.is_empty and combined_buf is not None) else 0.0
        grand_total_m += total_m
        grand_driven_m += combined_m

        # Houses driven by: building centroids within 40 m of any track.
        bpath = os.path.join(BASE, cfg["paths"]["buildings_dir"], f"{s}.geojson")
        buildings_total, houses_driven = 0, 0
        if os.path.exists(bpath):
            with open(bpath) as f:
                bgj = json.load(f)
            centroids = [ft["geometry"]["coordinates"] for ft in bgj["features"]]
            buildings_total = len(centroids)
            if centroids and house_buf is not None:
                mp = unary_union([Point(T.transform(lon, lat)) for lon, lat in centroids])
                inside = mp.intersection(house_buf)
                if inside.is_empty:
                    houses_driven = 0
                elif inside.geom_type == "Point":
                    houses_driven = 1
                else:
                    houses_driven = len(inside.geoms)
        grand_buildings += buildings_total
        grand_houses += houses_driven

        cities_out[city] = {
            "slug": s,
            "total_km": round(total_m / 1000.0, 2),
            "combined_driven_km": round(combined_m / 1000.0, 2),
            "combined_pct": round(combined_m / total_m * 100.0, 1) if total_m else 0.0,
            "remaining_km": round((total_m - combined_m) / 1000.0, 2),
            "buildings_total": buildings_total,
            "houses_driven": houses_driven,
            "houses_pct": round(houses_driven / buildings_total * 100.0, 1) if buildings_total else 0.0,
            "sessions": sess,
            "per_driver": per_driver,
        }

    out = {
        "generated_at": datetime.datetime.now().astimezone().isoformat(),
        "buffer_meters": buf_m,
        "cities": cities_out,
        "overall": {
            "total_km": round(grand_total_m / 1000.0, 2),
            "driven_km": round(grand_driven_m / 1000.0, 2),
            "pct": round(grand_driven_m / grand_total_m * 100.0, 1) if grand_total_m else 0.0,
            "buildings_total": grand_buildings,
            "houses_driven": grand_houses,
            "total_sessions": sum(b["num_drives"] for b in board.values()),
            "total_miles": round(sum(b["total_miles"] for b in board.values()), 1),
        },
        "leaderboard": board,
    }
    out_path = os.path.join(BASE, cfg["paths"]["coverage"])
    write_json_atomically(out_path, out)
    print(f"wrote {out_path}")
    for city, c in cities_out.items():
        print(f"  {city}: {c['combined_pct']}% ({c['combined_driven_km']}/{c['total_km']} km)")


if __name__ == "__main__":
    main()
