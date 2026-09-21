import { previewCoverage } from "./coverage_preview.mjs";
import { planCsvText } from "./import_preflight.mjs";

const QUEUE_KEY = "five-pointes.private-action-queue.v1";
const DEVICE_KEY = "five-pointes.private-device.v1";
const SEQUENCE_KEY = "five-pointes.private-action-sequence.v1";
const IMPORT_RUN_KEY = "five-pointes.private-import-run.v1";
const stages = new Set(["no_outreach", "reached_out", "waiting_for_reply", "in_conversation", "contractor_offer", "realtor_referral", "closed", "archived"]);
const $ = id => document.getElementById(id);

function readQueue() {
  try { const value = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}
function writeQueue(queue) { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); }
function deviceId() {
  let value = localStorage.getItem(DEVICE_KEY);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, value); }
  return value;
}
function toast(message) { $("toast").textContent = message; $("toast").classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => $("toast").classList.remove("show"), 3200); }
function refreshStatus(message) {
  const queue = readQueue();
  $("queueCount").textContent = `${queue.length} queued`;
  $("syncDetail").textContent = message || (queue.length ? `${queue.length} action${queue.length === 1 ? "" : "s"} waiting safely on this phone.` : "Nothing waiting to send.");
  const connected = navigator.onLine;
  $("connection").textContent = connected ? "Online — private sync available" : "Offline — captures stay on this phone";
  $("connection").classList.toggle("offline", !connected);
}
const TRACKER_FRESH_MS = 2 * 60 * 1000;
function renderTrackerSignal(status) {
  const lastSeen = status.latest_received_at ? Date.parse(status.latest_received_at) : NaN;
  const fresh = Number.isFinite(lastSeen) && Date.now() - lastSeen <= TRACKER_FRESH_MS;
  const signal = $("trackerSignal");
  signal.dataset.state = fresh ? "active" : status.active_devices ? "quiet" : "off";
  if (fresh) {
    $("trackerState").textContent = "Tracking is working";
    $("trackerDetail").textContent = "A private location report arrived within the last two minutes.";
  } else if (!status.active_devices) {
    $("trackerState").textContent = "Recorder is not configured";
    $("trackerDetail").textContent = "Prepare this iPhone before starting a drive.";
  } else {
    $("trackerState").textContent = "No recent tracker signal";
    $("trackerDetail").textContent = "Turn on Continuous tracking in Traccar and begin moving. This light turns green after a private report arrives.";
  }
}
async function refreshTrackerSignal() {
  try {
    const response = await fetch("/api/v1/recorders/status", { cache: "no-store" });
    if (!response.ok) throw new Error("tracker status unavailable");
    renderTrackerSignal(await response.json());
  } catch {
    $("trackerSignal").dataset.state = "checking";
    $("trackerState").textContent = "Tracker signal unavailable";
    $("trackerDetail").textContent = "Your Traccar settings were not changed. The private app will try again shortly.";
  }
}
function nextSequence() {
  const value = Number(localStorage.getItem(SEQUENCE_KEY) || 0) + 1;
  localStorage.setItem(SEQUENCE_KEY, String(value));
  return value;
}
function action(kind, propertyIdentity, payload) {
  return { event_id: crypto.randomUUID(), device_id: deviceId(), sequence: nextSequence(), occurred_at: new Date().toISOString(), kind, property_identity: propertyIdentity, payload };
}
function enqueue(item) { const queue = readQueue(); queue.push(item); writeQueue(queue); }
async function sync() {
  const queue = readQueue();
  if (!queue.length) return refreshStatus();
  if (!navigator.onLine) return refreshStatus("Offline — your queued captures will remain here until you reconnect.");
  $("syncNow").disabled = true;
  try {
    const response = await fetch("/api/v1/actions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actions: queue }) });
    if (!response.ok) throw new Error("sync failed");
    const result = await response.json();
    const confirmed = new Set([...(result.accepted_event_ids || []), ...(result.already_seen_event_ids || [])]);
    writeQueue(queue.filter(item => !confirmed.has(item.event_id)));
    refreshStatus();
    if (confirmed.size) refreshProperties();
    toast(confirmed.size ? "Saved to your shared workspace." : "Nothing new was accepted yet.");
  } catch { refreshStatus("Secure sync is unavailable. Your captures remain queued on this phone."); }
  finally { $("syncNow").disabled = false; }
}

const stageNames = {
  no_outreach: "Saved / no outreach", reached_out: "Reached out", waiting_for_reply: "Haven’t heard back", in_conversation: "In conversation",
  contractor_offer: "Contractor offer", realtor_referral: "Given to realtor", closed: "Closed", archived: "Passed / archived",
};
function timelineLabel(item) {
  if (item.kind === "property_saved") return "Saved";
  if (item.kind === "stage_changed") return `Stage: ${stageNames[item.payload.stage] || "Updated"}`;
  if (item.kind === "note_added") return `Note: ${item.payload.note}`;
  if (item.kind === "outreach_logged") return `Outreach: ${item.payload.method}`;
  return "Updated";
}
async function showProperty(identity) {
  try {
    const response = await fetch(`/api/v1/properties/${encodeURIComponent(identity)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("property unavailable");
    const property = await response.json();
    $("selectedProperty").textContent = property.summary.property_identity;
    $("selectedPropertySummary").textContent = `${stageNames[property.summary.stage] || "Saved"} · ${property.summary.action_count} saved action${property.summary.action_count === 1 ? "" : "s"}`;
    $("selectedPropertyStage").value = property.summary.stage || "no_outreach";
    $("selectedPropertyTimeline").replaceChildren(...property.timeline.map(item => {
      const entry = document.createElement("li");
      entry.textContent = `${new Date(item.occurred_at).toLocaleString()} — ${timelineLabel(item)}`;
      return entry;
    }));
    $("propertyDetail").hidden = false;
  } catch {
    $("propertiesDetail").textContent = "That saved home could not be loaded right now. Your local capture queue is unchanged.";
  }
}

async function saveSelectedPropertyAction(kind, payload, message) {
  const identity = $("selectedProperty").textContent.trim();
  if (!identity) return toast("Choose a saved home first.");
  enqueue(action(kind, identity, payload));
  refreshStatus();
  await sync();
  await showProperty(identity);
  toast(message);
}
async function refreshProperties() {
  const button = $("refreshProperties");
  button.disabled = true;
  try {
    const response = await fetch("/api/v1/properties", { cache: "no-store" });
    if (!response.ok) throw new Error("properties unavailable");
    const { properties } = await response.json();
    $("propertyCount").textContent = `${properties.length} saved`;
    const list = $("propertyList");
    list.replaceChildren(...properties.slice(0, 12).map(property => {
      const item = document.createElement("button");
      item.className = "property-row";
      item.type = "button";
      const identity = document.createElement("strong");
      identity.textContent = property.property_identity;
      const detail = document.createElement("span");
      detail.textContent = `${stageNames[property.stage] || "Saved"} · ${property.action_count} action${property.action_count === 1 ? "" : "s"}`;
      item.append(identity, detail);
      item.addEventListener("click", () => showProperty(property.property_identity));
      return item;
    }));
    if (!properties.length) $("propertiesDetail").textContent = "No saved homes yet. Add one with Quick capture while parked.";
    else $("propertiesDetail").textContent = "Your latest saved homes are shown below. These are household captures only.";
  } catch {
    $("propertyCount").textContent = "Unavailable";
    $("propertiesDetail").textContent = "Saved homes are unavailable right now. Your local capture queue is unchanged.";
  } finally { button.disabled = false; }
}

$("captureForm").addEventListener("submit", async event => {
  event.preventDefault();
  const submit = $("captureSubmit");
  if (submit.disabled) return;
  const identity = $("propertyIdentity").value.trim();
  const stage = $("stage").value;
  const note = $("note").value.trim();
  if (!identity || !stages.has(stage)) return toast("Enter a valid property ID and stage.");
  submit.disabled = true;
  submit.textContent = "Saving…";
  try {
    enqueue(action("property_saved", identity, {}));
    enqueue(action("stage_changed", identity, { stage }));
    if (note) enqueue(action("note_added", identity, { note }));
    $("captureForm").reset();
    refreshStatus();
    toast("Captured safely. Ready for the next home.");
    await sync();
  } finally {
    submit.disabled = false;
    submit.textContent = "Save observation";
  }
});
$("syncNow").addEventListener("click", sync);
$("refreshProperties").addEventListener("click", refreshProperties);
let plannedImport = null;
function renderImportProgress(progress) {
  $("importStageDetail").textContent = `${progress.processed_records} of ${progress.total_records} sanitized records reviewed; ${progress.review_records} require manual review. Status: ${progress.status.replaceAll("_", " ")}.`;
}
async function advanceImportRun(importId, progress) {
  let current = progress;
  while (current.status === "staged" && current.processed_records < current.total_records) {
    const response = await fetch(`/api/v1/import-plans/${encodeURIComponent(importId)}/advance`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batch_size: 500 }),
    });
    if (!response.ok) throw new Error("import review unavailable");
    current = await response.json();
    renderImportProgress(current);
  }
  return current;
}
$("importPreflightForm").addEventListener("submit", async event => {
  event.preventDefault();
  const file = $("importFile").files?.[0];
  if (!file) return toast("Choose a CSV file first.");
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  button.textContent = "Checking locally…";
  try {
    const plan = await planCsvText(await file.text(), $("importSource").value);
    if (plan.records.length > 5_000) throw new Error("This preflight has more than 5,000 records. Split the approved file before staging it.");
    plannedImport = plan;
    $("importStage").hidden = false;
    $("importDetail").textContent = `${plan.accepted} accepted, ${plan.review_required} requiring review, and ${plan.rejected} rejected. This local preflight did not upload or import the file.`;
  } catch (error) {
    $("importDetail").textContent = error instanceof Error ? error.message : "The CSV could not be checked locally.";
  } finally {
    button.disabled = false;
    button.textContent = "Check locally";
  }
});
$("stageImportPlan").addEventListener("click", async () => {
  if (!plannedImport) return toast("Check a CSV locally before staging it.");
  if (!$("importRightsConfirmed").checked) return toast("Confirm that this source is authorized before staging it.");
  const button = $("stageImportPlan");
  button.disabled = true;
  button.textContent = "Staging…";
  try {
    const response = await fetch("/api/v1/import-plans", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_name: plannedImport.source_name, source_fingerprint: plannedImport.source_fingerprint, rejected_count: plannedImport.rejected, records: plannedImport.records }),
    });
    if (!response.ok) throw new Error("staging unavailable");
    const staged = await response.json();
    localStorage.setItem(IMPORT_RUN_KEY, staged.import_id);
    renderImportProgress(await advanceImportRun(staged.import_id, staged));
    toast("Sanitized import plan is ready for household review.");
  } catch {
    $("importStageDetail").textContent = "The plan could not be staged. The local file and its raw values remain only on this device.";
  } finally {
    button.disabled = false;
    button.textContent = "Stage sanitized plan for review";
  }
});
async function refreshImportRun() {
  const importId = localStorage.getItem(IMPORT_RUN_KEY);
  if (!importId) return;
  try {
    const response = await fetch(`/api/v1/import-plans/${encodeURIComponent(importId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("import run unavailable");
    $("importStage").hidden = false;
    renderImportProgress(await response.json());
  } catch {
    // A stale local run ID is harmless; no file data is stored in the browser.
    localStorage.removeItem(IMPORT_RUN_KEY);
  }
}
$("propertyStageForm").addEventListener("submit", async event => {
  event.preventDefault();
  await saveSelectedPropertyAction("stage_changed", { stage: $("selectedPropertyStage").value }, "Stage saved to your shared workspace.");
});
$("propertyNoteForm").addEventListener("submit", async event => {
  event.preventDefault();
  const note = $("selectedPropertyNote").value.trim();
  if (!note) return toast("Write a note before saving it.");
  $("selectedPropertyNote").value = "";
  await saveSelectedPropertyAction("note_added", { note }, "Private note saved to your shared workspace.");
});
$("propertyOutreachForm").addEventListener("submit", async event => {
  event.preventDefault();
  await saveSelectedPropertyAction("outreach_logged", { method: $("selectedPropertyOutreach").value }, "Outreach saved to your shared workspace.");
});
$("prepareRecorder").addEventListener("click", async () => {
  const button = $("prepareRecorder");
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Preparing…";
  try {
    const response = await fetch("/api/v1/recorders/bootstrap", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    if (!response.ok) throw new Error("recorder setup failed");
    const setup = await response.json();
    $("recorderDevice").value = setup.device_id;
    $("recorderServer").value = setup.server_url;
    $("recorderConfig").hidden = false;
    $("recorderDetail").textContent = "This phone is ready for the pilot. Finish the two fields below in Traccar before starting a drive.";
    button.hidden = true;
    toast("Private recorder setup is ready on this phone.");
  } catch {
    toast("Recorder setup is unavailable. Nothing was changed on this phone.");
  } finally {
    button.disabled = false;
    button.textContent = "Prepare recorder";
  }
});
$("checkRecorder").addEventListener("click", async () => {
  const button = $("checkRecorder");
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    const response = await fetch("/api/v1/recorders/status", { cache: "no-store" });
    if (!response.ok) throw new Error("recorder status failed");
    const status = await response.json();
    if (!status.active_devices) $("recorderHealth").textContent = "No active recorder is configured on this account.";
    else if (!status.points_received) $("recorderHealth").textContent = "Recorder is ready. No location points have arrived yet.";
    else $("recorderHealth").textContent = `${status.points_received} location point${status.points_received === 1 ? "" : "s"} received privately.`;
  } catch {
    $("recorderHealth").textContent = "Recorder status is unavailable. Your settings were not changed.";
  } finally {
    button.disabled = false;
    button.textContent = "Check recorder";
  }
});

const STREET_FILES = [
  "/maps/grosse-pointe.geojson", "/maps/grosse-pointe-farms.geojson", "/maps/grosse-pointe-park.geojson",
  "/maps/grosse-pointe-shores.geojson", "/maps/grosse-pointe-woods.geojson",
];
let streetSegments;

async function roads() {
  if (streetSegments) return streetSegments;
  const collections = await Promise.all(STREET_FILES.map(async path => {
    const response = await fetch(path, { cache: "force-cache" });
    if (!response.ok) throw new Error("map data unavailable");
    return response.json();
  }));
  streetSegments = collections.flatMap(collection => (collection.features || []).flatMap(feature => {
    const geometry = feature.geometry || {};
    const name = feature.properties?.name || "Unnamed street";
    return (geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : []).map(coordinates => ({ name, coordinates }));
  }));
  return streetSegments;
}

function projectRoute(points, width, height) {
  const longitudes = points.map(point => point[0]);
  const latitudes = points.map(point => point[1]);
  const pad = 0.0008;
  const west = Math.min(...longitudes) - pad;
  const east = Math.max(...longitudes) + pad;
  const south = Math.min(...latitudes) - pad;
  const north = Math.max(...latitudes) + pad;
  const spanX = Math.max(east - west, pad * 2);
  const spanY = Math.max(north - south, pad * 2);
  return point => [((point[0] - west) / spanX) * width, height - ((point[1] - south) / spanY) * height];
}

function drawRoutePaths(routes, roadLines, coverage) {
  const canvas = $("routeMap");
  const width = canvas.clientWidth || 600;
  const height = width * 0.6;
  const pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * pixelRatio);
  canvas.height = Math.round(height * pixelRatio);
  const context = canvas.getContext("2d");
  context.scale(pixelRatio, pixelRatio);
  context.fillStyle = "#f4f7fb";
  context.fillRect(0, 0, width, height);
  const points = routes.flat();
  const project = projectRoute(points, width, height);
  context.strokeStyle = "#ccd5e3";
  context.lineWidth = 1;
  for (const road of roadLines) {
    if (!road.coordinates.length) continue;
    context.beginPath();
    road.coordinates.forEach((point, index) => {
      const [x, y] = project(point);
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.stroke();
  }
  context.strokeStyle = "#55a978";
  context.lineWidth = 3;
  for (const road of roadLines) {
    for (let index = 1; index < road.coordinates.length; index += 1) {
      if (!coverage.covered.has(`${road.name}|${index}`)) continue;
      const [startX, startY] = project(road.coordinates[index - 1]);
      const [endX, endY] = project(road.coordinates[index]);
      context.beginPath(); context.moveTo(startX, startY); context.lineTo(endX, endY); context.stroke();
    }
  }
  context.strokeStyle = "#2d6df6";
  context.lineWidth = routes.length === 1 ? 4 : 2.5;
  context.lineJoin = "round";
  context.lineCap = "round";
  for (const route of routes) {
    context.beginPath();
    route.forEach((point, index) => {
      const [x, y] = project(point);
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.stroke();
    for (const [point, color] of [[route[0], "#167a59"], [route.at(-1), "#d13f38"]]) {
      const [x, y] = project(point);
      context.fillStyle = color;
      context.beginPath();
      context.arc(x, y, 5, 0, Math.PI * 2);
      context.fill();
    }
  }
}

let routeSessionsLoaded = false;
function readableDistance(meters) {
  return meters >= 1609 ? `${(meters / 1609.344).toFixed(1)} mi` : `${Math.round(meters)} m`;
}
function readableDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  return minutes < 1 ? "under 1 min" : `${minutes} min`;
}
async function loadRouteSessions() {
  if (routeSessionsLoaded) return;
  const response = await fetch("/api/v1/recorders/sessions", { cache: "no-store" });
  if (!response.ok) throw new Error("drive history unavailable");
  const { sessions } = await response.json();
  const select = $("routeSession");
  select.replaceChildren(...sessions.map(session => {
    const option = document.createElement("option");
    option.value = session.session_id;
    option.textContent = `${new Date(session.started_at).toLocaleString()} — ${readableDistance(session.sampled_distance_meters)}, ${session.point_count} points`;
    return option;
  }));
  $("routeSelector").hidden = sessions.length < 2;
  routeSessionsLoaded = true;
}
async function loadSelectedRoute() {
  const button = $("loadRoute");
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    await loadRouteSessions();
    const session = $("routeSession").value;
    const response = await fetch(`/api/v1/recorders/latest-route${session ? `?session=${encodeURIComponent(session)}` : ""}`, { cache: "no-store" });
    if (!response.ok) throw new Error("route unavailable");
    const route = await response.json();
    if (route.coordinates.length < 2) {
      $("routeCount").textContent = "No drive yet";
      $("routeDetail").textContent = "There are not enough points for a route yet.";
      return;
    }
    const streetLines = await roads();
    const coverage = previewCoverage(route.coordinates, streetLines);
    drawRoutePaths([route.coordinates], streetLines, coverage);
    $("routeCount").textContent = `${route.point_count} points`;
    $("routeDetail").textContent = `Selected drive: ${readableDistance(route.sampled_distance_meters)} sampled over ${readableDuration(route.duration_seconds)} with ${route.point_count} points. Largest reporting gap: ${readableDistance(route.largest_gap_meters)}. Blue is the private route; green is the start and red is the finish.`;
    $("coverageDetail").textContent = `Green street segments are within 30 m of this selected drive: about ${readableDistance(coverage.coveredMeters)} of ${readableDistance(coverage.totalMeters)} in the bundled road network. This is a private per-drive preview.`;
  } catch {
    $("routeDetail").textContent = "The private route is unavailable right now. Nothing was shared outside this app.";
  } finally {
    button.disabled = false;
    button.textContent = "Show selected route";
  }
}
$("loadRoute").addEventListener("click", loadSelectedRoute);
$("routeSession").addEventListener("change", loadSelectedRoute);
$("loadHouseholdCoverage").addEventListener("click", async () => {
  const button = $("loadHouseholdCoverage");
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    await loadRouteSessions();
    const sessionIds = [...$("routeSession").options].map(option => option.value).filter(Boolean);
    const routes = await Promise.all(sessionIds.map(async session => {
      const response = await fetch(`/api/v1/recorders/latest-route?session=${encodeURIComponent(session)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("route unavailable");
      return response.json();
    }));
    const completedRoutes = routes.filter(route => route.coordinates.length >= 2);
    if (!completedRoutes.length) throw new Error("no completed routes");
    const streetLines = await roads();
    const coverage = previewCoverage(completedRoutes.map(route => route.coordinates), streetLines);
    drawRoutePaths(completedRoutes.map(route => route.coordinates), streetLines, coverage);
    const drivenMeters = completedRoutes.reduce((total, route) => total + route.sampled_distance_meters, 0);
    $("routeCount").textContent = `${completedRoutes.length} drives`;
    $("routeDetail").textContent = `${completedRoutes.length} completed household drive${completedRoutes.length === 1 ? "" : "s"} shown. Blue lines are private routes; green dots are starts and red dots are finishes.`;
    $("coverageDetail").textContent = `Green street segments are within 30 m of the ${readableDistance(drivenMeters)} sampled across these completed drives: about ${readableDistance(coverage.coveredMeters)} of ${readableDistance(coverage.totalMeters)} in the bundled road network. This household-wide view is private and calculated only in this browser.`;
  } catch {
    $("routeDetail").textContent = "Household coverage is unavailable right now. Nothing was shared outside this app.";
  } finally {
    button.disabled = false;
    button.textContent = "Show household coverage";
  }
});
document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
  const input = $(button.dataset.copy);
  try { await navigator.clipboard.writeText(input.value); toast("Copied privately to this phone."); }
  catch { input.select(); toast("Select and copy the private value."); }
}));
window.addEventListener("online", sync);
window.addEventListener("offline", () => refreshStatus());
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshTrackerSignal(); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});
refreshStatus();
refreshProperties();
refreshImportRun();
refreshTrackerSignal();
setInterval(() => { if (document.visibilityState === "visible") refreshTrackerSignal(); }, 15_000);
