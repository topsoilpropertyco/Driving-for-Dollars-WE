#!/usr/bin/env node
// Downloads only public parcel geometry from the Wayne County Parcel Viewer.
// No owner, address, APN, or other attributes are requested or retained.
import fs from "node:fs/promises";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const endpoint = "https://www.waynecounty.com/gisserver/rest/services/ParcelViewer/prcls_fullAdd_parsed_FINAL/FeatureServer/0/query";
const cities = {
  "grosse-pointe": "GROSSE POINTE",
  "grosse-pointe-farms": "GROSSE POINTE FARMS",
  "grosse-pointe-park": "GROSSE POINTE PARK",
  "grosse-pointe-shores": "GROSSE POINTE SHORES",
  "grosse-pointe-woods": "GROSSE POINTE WOODS",
};

function roundedRings(geometry) {
  return (geometry?.rings || []).map(ring => ring.map(([longitude, latitude]) => [Number(longitude.toFixed(6)), Number(latitude.toFixed(6))]));
}

async function request(form) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal: controller.signal }).finally(() => clearTimeout(timeout));
  if (!response.ok) throw new Error(`Parcel service returned ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(body.error.message || "Parcel service error");
  return body;
}

for (const [city, cityName] of Object.entries(cities)) {
  const parcels = [];
  let offset = 0;
  while (true) {
    const page = await request({
      f: "json", where: `propcity='${cityName}'`, outFields: "OBJECTID_1", returnGeometry: "true", outSR: "4326", geometryPrecision: "6", resultOffset: String(offset), resultRecordCount: "2000",
    });
    const features = page.features || [];
    parcels.push(...features.map(feature => roundedRings(feature.geometry)).filter(rings => rings.length));
    if (!page.exceededTransferLimit || !features.length) break;
    offset += features.length;
  }
  const output = { source: "Wayne County Parcel Viewer public geometry", retrieved_at: new Date().toISOString(), parcels };
  await fs.writeFile(path.join(root, "private_app", "maps", `parcel-lines-${city}.json`), JSON.stringify(output));
  console.log(`${city}: ${parcels.length} public parcel outlines`);
}
