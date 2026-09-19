#!/usr/bin/env python3
"""Download street networks, building footprints, and city boundaries
for the five Grosse Pointes.

Data source: the OpenStreetMap main API (api.openstreetmap.org), which proved
far more reliable from this network than Overpass (the egress proxy intermittently
truncates Overpass's chunked responses). Per city:

- Resolve the OSM relation id + bbox via Nominatim.
- Fetch the boundary via /api/0.6/relation/<id>/full, polygonize outer/inner.
- Tile-fetch /api/0.6/map over the city bbox (recursive quad-split when the
  API reports too many nodes; ways are returned complete so tiles dedupe by id).
- Keep drivable street ways (highway class filter) clipped to the boundary.
- Keep building=* footprints as centroid points within the boundary.

Caches to data/streets/<slug>.geojson, data/buildings/<slug>.geojson,
and data/boundaries/<slug>.geojson. Skips cached cities unless
--refresh-streets is passed.
"""
import argparse
import json
import os
import sys
import time
from xml.etree import ElementTree as ET

import requests
import yaml
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, mapping
from shapely.ops import linemerge, polygonize

BASE = os.path.dirname(os.path.abspath(__file__))
NOMINATIM = "https://nominatim.openstreetmap.org/search"
OSM_API = "https://api.openstreetmap.org/api/0.6"
UA = {"User-Agent": "GrossePointeCoverageTracker/1.0"}

HIGHWAY_SET = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "living_street",
}


def slug(name):
    return name.lower().replace(" ", "-")


class TileTooBig(Exception):
    pass


def http_get(url, params=None, tries=5):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, headers=UA, timeout=300)
            if r.status_code == 400 and "too many nodes" in r.text:
                raise TileTooBig(r.text[:120])
            r.raise_for_status()
            return r
        except TileTooBig:
            raise
        except Exception as e:
            last = e
            if i < tries - 1:
                wait = 5 * (2 ** i)
                print(f"    request failed ({str(e)[:100]}); retry {i + 2}/{tries} in {wait}s")
                time.sleep(wait)
    raise RuntimeError(f"request failed after {tries} tries: {last}")


def resolve_relation(city):
    params = {"format": "json", "q": f"{city}, Wayne County, Michigan", "limit": 3}
    results = http_get(NOMINATIM, params=params).json()
    rels = [x for x in results if x.get("osm_type") == "relation"]
    if not rels:
        raise RuntimeError(f"Nominatim returned no relation for '{city}'")
    rels.sort(key=lambda x: 0 if "boundary" in (x.get("category", "") + x.get("type", "")) else 1)
    r = rels[0]
    bb = [float(v) for v in r["boundingbox"]]  # [minlat, maxlat, minlon, maxlon]
    return int(r["osm_id"]), r.get("display_name", ""), (bb[2], bb[0], bb[3], bb[1])


def parse_osm_xml(content):
    """Parse an OSM XML doc -> (nodes, ways, relations) dicts keyed by id."""
    root = ET.fromstring(content)
    nodes = {}
    for n in root.findall("node"):
        nodes[n.get("id")] = (float(n.get("lon")), float(n.get("lat")))
    ways = {}
    for w in root.findall("way"):
        tags = {t.get("k"): t.get("v") for t in w.findall("tag")}
        nds = [nd.get("ref") for nd in w.findall("nd")]
        ways[w.get("id")] = {"tags": tags, "nds": nds}
    relations = {}
    for rel in root.findall("relation"):
        tags = {t.get("k"): t.get("v") for t in rel.findall("tag")}
        members = [(m.get("type"), m.get("ref"), m.get("role")) for m in rel.findall("member")]
        relations[rel.get("id")] = {"tags": tags, "members": members}
    return nodes, ways, relations


def fetch_tile(bbox):
    """bbox = (minlon, minlat, maxlon, maxlat). Raises TileTooBig if over the node limit."""
    minlon, minlat, maxlon, maxlat = bbox
    r = http_get(f"{OSM_API}/map", params={"bbox": f"{minlon},{minlat},{maxlon},{maxlat}"})
    return parse_osm_xml(r.content)


def fetch_area(bbox, depth=0):
    """Recursively quad-split the bbox until the node limit is satisfied.
    Returns merged (nodes, ways, relations); ways dedupe by id (complete in each tile)."""
    try:
        return fetch_tile(bbox)
    except TileTooBig:
        if depth > 6:
            raise RuntimeError(f"bbox {bbox} still too big after 6 splits")
        minlon, minlat, maxlon, maxlat = bbox
        midlon, midlat = (minlon + maxlon) / 2, (minlat + maxlat) / 2
        quads = [
            (minlon, minlat, midlon, midlat),
            (midlon, minlat, maxlon, midlat),
            (minlon, midlat, midlon, maxlat),
            (midlon, midlat, maxlon, maxlat),
        ]
        nodes, ways, relations = {}, {}, {}
        for q in quads:
            n, w, r = fetch_area(q, depth + 1)
            nodes.update(n)
            ways.update(w)
            relations.update(r)
            time.sleep(1)
        return nodes, ways, relations


def fetch_boundary(rel_id):
    """Fetch the full relation; polygonize outer/inner member ways."""
    r = http_get(f"{OSM_API}/relation/{rel_id}/full")
    nodes, ways, relations = parse_osm_xml(r.content)
    rel = relations.get(str(rel_id))
    if rel is None:
        raise RuntimeError(f"relation {rel_id} not in /full response")
    outer, inner = [], []
    for mtype, ref, role in rel["members"]:
        if mtype != "way" or ref not in ways:
            continue
        coords = [nodes[nd] for nd in ways[ref]["nds"] if nd in nodes]
        if len(coords) < 2:
            continue
        line = LineString(coords)
        if role == "outer":
            outer.append(line)
        elif role == "inner":
            inner.append(line)
    polys = list(polygonize(linemerge(outer))) if outer else []
    holes = list(polygonize(linemerge(inner))) if inner else []
    cleaned = []
    for p in polys:
        for h in holes:
            if p.intersects(h):
                p = p.difference(h)
        cleaned.append(p)
    if not cleaned:
        raise RuntimeError(f"could not build boundary polygon for relation {rel_id}")
    multi = {
        "type": "MultiPolygon",
        "coordinates": [mapping(p)["coordinates"] for p in cleaned],
    }
    boundary = {"type": "FeatureCollection",
                "features": [{"type": "Feature", "properties": {}, "geometry": multi}]}
    # Also return shapely polys (lon/lat) for clipping streets/buildings.
    return boundary, cleaned


def way_coords(way, nodes):
    return [nodes[nd] for nd in way["nds"] if nd in nodes]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh-streets", action="store_true",
                        help="re-download even if cached")
    args = parser.parse_args()
    cfg = yaml.safe_load(open(os.path.join(BASE, "config.yaml")))
    streets_dir = os.path.join(BASE, cfg["paths"]["streets_dir"])
    bound_dir = os.path.join(BASE, cfg["paths"]["boundaries_dir"])
    build_dir = os.path.join(BASE, cfg["paths"]["buildings_dir"])
    os.makedirs(streets_dir, exist_ok=True)
    os.makedirs(bound_dir, exist_ok=True)
    os.makedirs(build_dir, exist_ok=True)

    failed = []
    for city in cfg["cities"]:
        s = slug(city)
        sp = os.path.join(streets_dir, f"{s}.geojson")
        bp = os.path.join(bound_dir, f"{s}.geojson")
        up = os.path.join(build_dir, f"{s}.geojson")
        if all(os.path.exists(p) for p in (sp, bp, up)) and not args.refresh_streets:
            n = len(json.load(open(sp))["features"])
            m = len(json.load(open(up))["features"])
            print(f"[{city}] cached ({n} ways, {m} buildings) — skipping (use --refresh-streets to redo)")
            continue
        try:
            print(f"[{city}] resolving OSM relation...")
            rel_id, label, bbox = resolve_relation(city)
            print(f"[{city}] relation {rel_id} ({label[:60]})")
            print(f"[{city}] downloading boundary...")
            boundary, polys = fetch_boundary(rel_id)
            city_poly = polys[0] if len(polys) == 1 else MultiPolygon(polys)

            pad = 0.005
            minlon, minlat, maxlon, maxlat = bbox
            area = (minlon - pad, minlat - pad, maxlon + pad, maxlat + pad)
            print(f"[{city}] downloading map tiles...")
            nodes, ways, relations = fetch_area(area)
            print(f"[{city}] {len(nodes)} nodes, {len(ways)} ways, {len(relations)} relations")

            street_feats, building_feats = [], []
            for wid, way in ways.items():
                tags = way["tags"]
                coords = way_coords(way, nodes)
                if len(coords) < 2:
                    continue
                if tags.get("highway") in HIGHWAY_SET:
                    line = LineString(coords)
                    if line.intersects(city_poly):
                        street_feats.append({
                            "type": "Feature",
                            "properties": {"name": tags.get("name", ""),
                                           "highway": tags.get("highway", "")},
                            "geometry": {"type": "LineString", "coordinates": coords},
                        })
                if "building" in tags:
                    if len(coords) >= 4:
                        try:
                            c = Polygon(coords).centroid
                        except Exception:
                            c = Point(sum(p[0] for p in coords) / len(coords),
                                      sum(p[1] for p in coords) / len(coords))
                    else:
                        c = Point(sum(p[0] for p in coords) / len(coords),
                                  sum(p[1] for p in coords) / len(coords))
                    if city_poly.contains(c):
                        building_feats.append({
                            "type": "Feature",
                            "properties": {"building": tags.get("building", ""), "source": "way"},
                            "geometry": {"type": "Point", "coordinates": [c.x, c.y]},
                        })
            # Building multipolygon relations: centroid from member way nodes.
            for rid, rel in relations.items():
                if "building" not in rel["tags"]:
                    continue
                xs, ys, n = 0.0, 0.0, 0
                for mtype, ref, role in rel["members"]:
                    if mtype != "way" or ref not in ways:
                        continue
                    for lon, lat in way_coords(ways[ref], nodes):
                        xs += lon
                        ys += lat
                        n += 1
                if n and city_poly.contains(Point(xs / n, ys / n)):
                    building_feats.append({
                        "type": "Feature",
                        "properties": {"building": rel["tags"].get("building", ""), "source": "relation"},
                        "geometry": {"type": "Point", "coordinates": [xs / n, ys / n]},
                    })

            with open(sp, "w") as f:
                json.dump({"type": "FeatureCollection", "features": street_feats}, f)
            with open(bp, "w") as f:
                json.dump(boundary, f)
            with open(up, "w") as f:
                json.dump({"type": "FeatureCollection", "features": building_feats}, f)
            print(f"[{city}] saved {len(street_feats)} street ways, {len(building_feats)} buildings")
        except Exception as e:
            failed.append(city)
            print(f"[{city}] FAILED: {e} — will retry on next run")
        time.sleep(2)

    if failed:
        print(f"\n{len(failed)} cities failed: {', '.join(failed)}")
        print("Re-run streets.py to retry them (cached cities are skipped).")
        sys.exit(1)
    print("\nAll cities downloaded.")


if __name__ == "__main__":
    main()
