#!/usr/bin/env python3
"""Render dashboard.html — a self-contained Leaflet map.

All data is inlined as JS variables, so the file works when opened directly
(file://) with no server. Leaflet + OSM tiles come from CDN (needs internet).

Layout: header vanity-metric cards, sidebar with the five cities (closest to
Detroit first, priority cities starred) + Seth-vs-Claire leaderboard, and an
interactive map with coverage-colored city polygons, per-city boundary layers,
click popups with city stats, a glowing undriven-streets layer, a 📍 locate-me
control with follow mode, and a "Where to drive next" panel with per-city
"Start here" pins + Google Maps navigation links.

Privacy: set PUBLIC_BUILD=1 to render the public build, which omits the
per-driver GPS track layers (raw location history never leaves the runner).
The public build keeps aggregate stats, the leaderboard, coverage polygons,
undriven streets, and start-here pins — all safe to publish.
"""
import datetime
import glob
import json
import os

import yaml

from artifact_io import write_text_atomically

BASE = os.path.dirname(os.path.abspath(__file__))

DRIVER_COLOR = {"seth": "#1e6fff", "claire": "#ff7f0e"}
DRIVER_NAME = {"seth": "Seth", "claire": "Claire"}


def slug(name):
    return name.lower().replace(" ", "-")


def r5(x):
    return round(x, 5)


def round_coords(coords):
    # GeoJSON coords are [lon, lat] (possibly nested); round to 5 decimals.
    if isinstance(coords[0], (int, float)):
        return [r5(coords[0]), r5(coords[1])]
    return [round_coords(c) for c in coords]


def bar(pct):
    color = "#e74c3c" if pct < 34 else "#f1c40f" if pct < 67 else "#27ae60"
    return (
        '<div class="bar"><div class="fill" style="width:{:.1f}%;background:{}"></div></div>'
        .format(min(pct, 100), color)
    )


def sidebar_html(cov, cities, priority, sync_time, athletes):
    lb = cov["leaderboard"]
    overall = cov["overall"]
    parts = []

    # ---- Vanity metric header cards ----
    def split_card(num, lbl, splits):
        inner = " &middot; ".join(
            f'<span class="dot" style="background:{DRIVER_COLOR[a]}"></span>'
            f"{DRIVER_NAME[a]} {splits[a]}" for a in athletes
        )
        return (f'<div class="card"><div class="num">{num}</div>'
                f'<div class="lbl">{lbl}</div><div class="split">{inner}</div></div>')

    parts.append('<div class="cards">')
    parts.append(
        f'<div class="card"><div class="num">{overall["pct"]:.1f}%</div>'
        f'<div class="lbl">overall street coverage</div>'
        f'<div class="split">{overall["driven_km"]:.1f} of {overall["total_km"]:.1f} km</div></div>')
    parts.append(split_card(f'{overall["total_sessions"]}', "driving sessions",
                            {a: lb[a]["num_drives"] for a in athletes}))
    parts.append(split_card(f'{overall["total_miles"]:.1f}', "miles driven",
                            {a: f'{lb[a]["total_miles"]:.1f}' for a in athletes}))
    parts.append(
        f'<div class="card"><div class="num">{overall["houses_driven"]:,}</div>'
        f'<div class="lbl">houses driven by (approx)</div>'
        f'<div class="split">of {overall["buildings_total"]:,} mapped</div></div>')
    parts.append('</div>')

    # ---- Cities in Detroit-first order, priority starred ----
    parts.append("<h2>Cities</h2>")
    for city in cities:
        c = cov["cities"][city]
        star = "★ " if city in priority else ""
        parts.append(
            f'<div class="city"><div class="cityrow"><span>{star}{city}</span>'
            f'<span>{c["combined_pct"]:.1f}%</span></div>'
            f'{bar(c["combined_pct"])}'
            f'<div class="remain">{c["remaining_km"]:.1f} km of streets remaining &middot; '
            f'{c["houses_driven"]:,} houses passed &middot; '
            f'{c["sessions"]["total"]} sessions</div></div>'
        )

    # ---- Where to drive next ----
    parts.append("<h2>Where to drive next</h2>")
    parts.append('<div id="starthere">')
    for city in cities:
        star = "★ " if city in priority else ""
        parts.append(
            f'<div class="shrow"><span>{star}{city}</span>'
            f'<button class="startbtn" onclick=\'startHere("{city}")\'>Start here</button></div>'
        )
    parts.append('</div>')
    parts.append('<div id="starthereBox"></div>')

    # ---- Seth vs Claire leaderboard ----
    parts.append("<h2>Seth vs Claire</h2>")
    parts.append('<table class="lb"><tr><th>Driver</th><th>Sessions</th>'
                 '<th>Miles</th><th>Last drive</th></tr>')
    for a in athletes:
        b = lb[a]
        last = (b["last_drive_date"] or "—")[:10]
        parts.append(
            f'<tr><td><span class="dot" style="background:{DRIVER_COLOR[a]}"></span>'
            f'{DRIVER_NAME[a]}</td><td>{b["num_drives"]}</td>'
            f'<td>{b["total_miles"]:.1f}</td><td>{last}</td></tr>'
        )
    parts.append("</table>")
    parts.append('<table class="lb"><tr><th>City</th>'
                 + "".join(f"<th>{DRIVER_NAME[a]}</th>" for a in athletes)
                 + "<th>Both</th></tr>")
    for city in cities:
        c = cov["cities"][city]
        star = "★ " if city in priority else ""
        row = f"<tr><td>{star}{city}</td>"
        for a in athletes:
            row += f"<td>{c['per_driver'][a]['pct']:.1f}%</td>"
        row += f"<td><b>{c['combined_pct']:.1f}%</b></td></tr>"
        parts.append(row)
    parts.append("</table>")
    parts.append(f'<p class="sync">Last sync: {sync_time}</p>')
    return "\n".join(parts)


TEMPLATE = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>Grosse Pointe Driving Coverage</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
  html,body{margin:0;height:100%;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  #wrap{display:flex;height:100%}
  #sidebar{width:380px;min-width:320px;overflow-y:auto;padding:16px 18px;background:#fafafa;border-right:1px solid #ddd}
  #map{flex:1}
  h1{font-size:20px;margin:0 0 10px} h2{font-size:15px;margin:18px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
  .sync{color:#666;font-size:12px;margin:12px 0 0}
  .cards{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px}
  .card{background:#fff;border:1px solid #e2e2e2;border-radius:8px;padding:10px 12px}
  .card .num{font-size:22px;font-weight:700}
  .card .lbl{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.4px;margin:2px 0}
  .card .split{font-size:12px;color:#333}
  table.lb{border-collapse:collapse;width:100%;font-size:12.5px;margin-bottom:10px}
  table.lb th,table.lb td{border:1px solid #ddd;padding:4px 6px;text-align:left}
  table.lb th{background:#f0f0f0}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
  .bar{height:10px;background:#e8e8e8;border-radius:5px;overflow:hidden;margin:4px 0}
  .fill{height:100%;border-radius:5px}
  .city{margin:10px 0} .cityrow{display:flex;justify-content:space-between;font-size:13px;font-weight:600}
  .remain{font-size:12px;color:#666}
  .legend{font-size:12px;color:#555;margin-top:14px}
  .leaflet-popup-content{font-size:13px;line-height:1.5}
  .startbtn{background:#1e6fff;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer}
  .startbtn:hover{background:#1558d6}
  .shrow{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:3px 0}
  #starthereBox{background:#fff;border:1px solid #e2e2e2;border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.6;margin-top:8px;display:none}
  #starthereBox .muted{color:#666;font-size:12px}
  .pulse-wrap{background:none;border:none}
  .pulse-dot{width:14px;height:14px;background:#1e6fff;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 0 rgba(30,111,255,.55);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(30,111,255,.55)}70%{box-shadow:0 0 0 14px rgba(30,111,255,0)}100%{box-shadow:0 0 0 0 rgba(30,111,255,0)}}
  #geoNotice{position:absolute;top:12px;left:50%;transform:translateX(-50%);z-index:1000;background:#333;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;display:none;box-shadow:0 2px 8px rgba(0,0,0,.3);max-width:80%}
</style></head>
<body><div id="wrap">
<div id="sidebar">__SIDEBAR__<div class="legend">City boundaries are colored red&rarr;yellow&rarr;green by combined street coverage. <b style="color:#ff2d55">Glowing red streets</b> are undriven — toggle them with the layer control (top right). Tap <b>📍</b> on the map to show your live location, then <b>Start here</b> under "Where to drive next" to get a starting corner. Click a city for its stats. ★ marks Seth's priority cities.</div></div>
<div id="map"><div id="geoNotice"></div></div>
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const BOUNDARIES = __BOUNDARIES__;
const TRACKS = __TRACKS__;
const COVERAGE = __COVERAGE__;
const PRIORITY = __PRIORITY__;
const UNDRIVEN = __UNDRIVEN__;
const STARTHERE = __STARTHERE__;
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function coverageColor(p){
  p = Math.max(0, Math.min(100, p));
  const c1=[231,76,60], c2=[241,196,15], c3=[39,174,96];
  let a,b,t;
  if(p<=50){a=c1;b=c2;t=p/50;}else{a=c2;b=c3;t=(p-50)/50;}
  const c=a.map((v,i)=>Math.round(v+(b[i]-v)*t));
  return 'rgb('+c[0]+','+c[1]+','+c[2]+')';
}
function cityPopup(city){
  const c = COVERAGE.cities[city];
  const star = PRIORITY.indexOf(city) >= 0 ? ' ★' : '';
  return '<b>'+city+star+'</b><br>'+
    'Street coverage: <b>'+c.combined_pct.toFixed(1)+'%</b><br>'+
    'Streets driven: '+c.combined_driven_km.toFixed(1)+' of '+c.total_km.toFixed(1)+' km<br>'+
    'Houses passed: '+c.houses_driven.toLocaleString()+' of '+c.buildings_total.toLocaleString()+'<br>'+
    'Sessions: '+c.sessions.total+' (Seth '+c.sessions.seth+', Claire '+c.sessions.claire+')';
}
const map = L.map('map').setView([42.43, -82.90], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(map);
const bounds = [];
const overlays = {};
for (const city of Object.keys(BOUNDARIES)) {
  const pct = COVERAGE.cities[city].combined_pct;
  const col = coverageColor(pct);
  const layer = L.geoJSON(BOUNDARIES[city],
    {style: {color: col, weight: 2, fillColor: col, fillOpacity: 0.22}});
  layer.bindPopup(cityPopup(city));
  layer.addTo(map);
  layer.eachLayer(l => bounds.push(l.getBounds()));
  overlays[city + ' boundary'] = layer;
}
__DRIVER_LAYERS__

// ---- Undriven streets: white casing + glowing red line, one toggle group ----
const undrivenAll = L.layerGroup();
for (const city of Object.keys(UNDRIVEN)) {
  const gj = UNDRIVEN[city];
  if (!gj || !gj.features || !gj.features.length) continue;
  const casing = L.geoJSON(gj, {style: {color: '#ffffff', weight: 8, opacity: 0.9, interactive: false}});
  const glow = L.geoJSON(gj, {style: {color: '#ff2d55', weight: 3.5, opacity: 0.95}});
  glow.eachLayer(l => {
    const p = l.feature.properties || {};
    const nm = p.name || 'Unnamed street';
    l.bindPopup('<b>' + esc(nm) + '</b><br>undriven &middot; ' + (p.length_m / 1000).toFixed(2) + ' km');
  });
  casing.addTo(undrivenAll);
  glow.addTo(undrivenAll);
}
undrivenAll.addTo(map);
overlays['Undriven streets'] = undrivenAll;

L.control.layers(null, overlays, {collapsed: false}).addTo(map);
if (bounds.length) map.fitBounds(L.latLngBounds(bounds).pad(0.05));

// ---- Locate me: live "you are here" dot + optional follow mode ----
let userPos = null;   // [lat, lon]
let userMarker = null;
let watchId = null;
let followMode = false;
function geoNotice(msg) {
  const n = document.getElementById('geoNotice');
  n.textContent = msg;
  n.style.display = 'block';
  clearTimeout(n._t);
  n._t = setTimeout(() => { n.style.display = 'none'; }, 5000);
}
const locateCtl = L.control({position: 'topleft'});
locateCtl.onAdd = function() {
  const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
  div.innerHTML = '<a href="#" id="locateBtn" title="Locate me" role="button">📍</a>' +
                  '<a href="#" id="followBtn" title="Follow me" role="button" style="display:none">🧭</a>';
  L.DomEvent.disableClickPropagation(div);
  div.querySelector('#locateBtn').addEventListener('click', function(e) {
    L.DomEvent.preventDefault(e);
    toggleLocate();
  });
  div.querySelector('#followBtn').addEventListener('click', function(e) {
    L.DomEvent.preventDefault(e);
    followMode = !followMode;
    e.target.style.background = followMode ? '#dceaff' : '';
    if (followMode && userPos) map.setView(userPos, Math.max(map.getZoom(), 15));
  });
  return div;
};
locateCtl.addTo(map);
function toggleLocate() {
  const btn = document.getElementById('locateBtn');
  const fbtn = document.getElementById('followBtn');
  if (watchId !== null) {  // tapped again: turn tracking off
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    userPos = null; followMode = false;
    btn.style.background = ''; fbtn.style.display = 'none'; fbtn.style.background = '';
    return;
  }
  if (!navigator.geolocation) { geoNotice('Geolocation is not available in this browser.'); return; }
  btn.style.background = '#dceaff';
  watchId = navigator.geolocation.watchPosition(
    function(pos) {
      userPos = [pos.coords.latitude, pos.coords.longitude];
      if (!userMarker) {
        userMarker = L.marker(userPos, {
          icon: L.divIcon({className: 'pulse-wrap', html: '<div class="pulse-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10]}),
          zIndexOffset: 1000
        }).addTo(map);
        fbtn.style.display = '';
        map.setView(userPos, Math.max(map.getZoom(), 14));
      } else {
        userMarker.setLatLng(userPos);
      }
      if (followMode) map.panTo(userPos);
    },
    function(err) {
      geoNotice('Location unavailable: ' + ((err && err.message) || 'permission denied'));
      if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      btn.style.background = '';
    },
    {enableHighAccuracy: true, maximumAge: 5000, timeout: 15000}
  );
}

// ---- Where to drive next: pick a start pin per city ----
let startPin = null;
function startHere(city) {
  const box = document.getElementById('starthereBox');
  box.style.display = 'block';
  const clusters = STARTHERE[city] || [];
  if (!clusters.length) {
    box.innerHTML = '<b>' + esc(city) + '</b>: 🎉 fully driven — nothing left!';
    return;
  }
  let cl, mode;
  if (userPos) {
    let best = clusters[0], bd = Infinity;
    for (const c of clusters) {
      const d = (c.lat - userPos[0]) * (c.lat - userPos[0]) + (c.lon - userPos[1]) * (c.lon - userPos[1]);
      if (d < bd) { bd = d; best = c; }
    }
    cl = best;
    mode = 'nearest big undriven patch to your location';
  } else {
    cl = clusters[0];
    mode = 'largest undriven patch in ' + city + ' (tap 📍 Locate me first to pick the nearest one instead)';
  }
  if (startPin) map.removeLayer(startPin);
  startPin = L.marker([cl.lat, cl.lon]).addTo(map);
  const s = cl.streets || [];
  let where;
  if (s.length >= 2) where = 'Start near the corner of <b>' + esc(s[0]) + '</b> and <b>' + esc(s[1]) + '</b>';
  else if (s.length === 1) where = 'Start on <b>' + esc(s[0]) + '</b>';
  else where = 'Start near ' + cl.lat.toFixed(5) + ', ' + cl.lon.toFixed(5);
  box.innerHTML = '<b>' + esc(city) + '</b><br>' + where +
    '<br><span class="muted">' + esc(mode) + ' &middot; about ' + cl.km + ' km of undriven streets nearby</span>' +
    '<br><a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=' + cl.lat + ',' + cl.lon + '">Navigate in Google Maps &rarr;</a>';
  startPin.bindPopup(where).openPopup();
  map.setView([cl.lat, cl.lon], 15);
}
</script></body></html>
"""


def main():
    cfg = yaml.safe_load(open(os.path.join(BASE, "config.yaml")))
    athletes = cfg["strava"]["athletes"]
    cities = cfg["cities"]
    priority = cfg.get("priority_cities", [])
    cov = json.load(open(os.path.join(BASE, cfg["paths"]["coverage"])))

    boundaries = {}
    for city in cities:
        s = slug(city)
        gj = json.load(open(os.path.join(BASE, cfg["paths"]["boundaries_dir"], f"{s}.geojson")))
        feats = []
        for ft in gj["features"]:
            feats.append({
                "type": "Feature",
                "properties": {},
                "geometry": {"type": ft["geometry"]["type"],
                             "coordinates": round_coords(ft["geometry"]["coordinates"])},
            })
        boundaries[city] = {"type": "FeatureCollection", "features": feats}

    tracks = []
    public = os.environ.get("PUBLIC_BUILD") == "1"
    if not public:
        for athlete in athletes:
            for path in sorted(glob.glob(os.path.join(BASE, cfg["paths"]["tracks_dir"], f"{athlete}_*.json"))):
                t = json.load(open(path))
                ll = t.get("latlng") or []
                if len(ll) < 2:
                    continue
                tracks.append({
                    "athlete": athlete,
                    "name": t.get("name") or "Drive",
                    "date": (t.get("date") or "")[:10],
                    "km": round((t.get("distance_m") or 0) / 1000.0, 2),
                    "coords": [[r5(lat), r5(lon)] for lat, lon in ll],  # Leaflet wants [lat, lng]
                })

    if public:
        driver_layers_js = ""
    else:
        driver_layers_js = """const driverLayers = {seth: L.layerGroup(), claire: L.layerGroup()};
const driverColor = {seth: '#1e6fff', claire: '#ff7f0e'};
const driverName = {seth: 'Seth', claire: 'Claire'};
for (const t of TRACKS) {
  const line = L.polyline(t.coords,
    {color: driverColor[t.athlete] || '#888', weight: 3, opacity: 0.85});
  line.bindPopup('<b>'+t.name+'</b><br>'+t.date+' &middot; '+t.km+' km &middot; '+driverName[t.athlete]);
  driverLayers[t.athlete].addLayer(line);
}
driverLayers.seth.addTo(map); driverLayers.claire.addTo(map);
overlays["Seth's drives"] = driverLayers.seth;
overlays["Claire's drives"] = driverLayers.claire;"""

    sync_time = datetime.datetime.now().astimezone().strftime("%b %d, %Y %I:%M %p %Z")

    undriven = {}
    for city in cities:
        s = slug(city)
        up = os.path.join(BASE, cfg["paths"]["undriven_dir"], f"{s}.geojson")
        if os.path.exists(up):
            undriven[city] = json.load(open(up))  # coords already rounded to 5 dp
        else:
            undriven[city] = {"type": "FeatureCollection", "features": []}
    shp_path = os.path.join(BASE, cfg["paths"]["starthere"])
    starthere = json.load(open(shp_path)) if os.path.exists(shp_path) else {}

    html = (TEMPLATE
            .replace("__BOUNDARIES__", json.dumps(boundaries))
            .replace("__TRACKS__", json.dumps(tracks))
            .replace("__DRIVER_LAYERS__", driver_layers_js)
            .replace("__COVERAGE__", json.dumps(cov))
            .replace("__PRIORITY__", json.dumps(priority))
            .replace("__UNDRIVEN__", json.dumps(undriven))
            .replace("__STARTHERE__", json.dumps(starthere))
            .replace("__SIDEBAR__", sidebar_html(cov, cities, priority, sync_time, athletes)))
    out = os.path.join(BASE, cfg["paths"]["dashboard"])
    write_text_atomically(out, html)
    print(f"wrote {out} ({os.path.getsize(out) / 1024:.0f} KB, {len(tracks)} tracks)")


if __name__ == "__main__":
    main()
