import { previewCoverage } from "./coverage_preview.mjs";

const QUEUE_KEY = "five-pointes.private-action-queue.v1";
const DEVICE_KEY = "five-pointes.private-device.v1";
const SEQUENCE_KEY = "five-pointes.private-action-sequence.v1";
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
function relativeAge(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} min ago`;
}
function renderTrackerSignal(status) {
  const lastSeen = status.latest_received_at ? Date.parse(status.latest_received_at) : NaN;
  const fresh = Number.isFinite(lastSeen) && Date.now() - lastSeen <= TRACKER_FRESH_MS;
  const seenDetail = Number.isFinite(lastSeen) ? ` Last private report: ${relativeAge(Date.now() - lastSeen)}.` : "";
  const signal = $("trackerSignal");
  signal.dataset.state = fresh ? "active" : status.active_devices ? "quiet" : "off";
  if (fresh) {
    $("trackerState").textContent = "Tracking is working";
    $("trackerDetail").textContent = `A private location report arrived within the last two minutes.${seenDetail}`;
  } else if (!status.active_devices) {
    $("trackerState").textContent = "Recorder is not configured";
    $("trackerDetail").textContent = "Prepare this iPhone before starting a drive.";
  } else {
    $("trackerState").textContent = "No recent tracker signal";
    $("trackerDetail").textContent = `Turn on Continuous tracking in Traccar and begin moving. This light turns green after a private report arrives.${seenDetail}`;
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
const PRIVATE_TAG_PREFIX = "five_pointes_private_tag:";
function privateTagNote(tag) { return `${PRIVATE_TAG_PREFIX}${JSON.stringify(tag)}`; }
function tagFromTimeline(item) {
  if (item.kind !== "note_added" || typeof item.payload.note !== "string" || !item.payload.note.startsWith(PRIVATE_TAG_PREFIX)) return null;
  try { return JSON.parse(item.payload.note.slice(PRIVATE_TAG_PREFIX.length)); } catch { return null; }
}
function timelineLabel(item) {
  if (item.kind === "property_saved") return "Saved";
  const tag = tagFromTimeline(item);
  if (tag) return `${conditionNames[tag.condition] || "Tagged"} · ${tag.score}/10${Number.isFinite(tag.latitude) ? " · map star" : ""}`;
  if (item.kind === "property_tagged") return `${conditionNames[item.payload.condition] || "Tagged"} · ${item.payload.score}/10${Number.isFinite(item.payload.latitude) ? " · map star" : ""}`;
  if (item.kind === "stage_changed") return `Stage: ${stageNames[item.payload.stage] || "Updated"}`;
  if (item.kind === "note_added") return `Note: ${item.payload.note}`;
  if (item.kind === "outreach_logged") return `Outreach: ${item.payload.method}`;
  return "Updated";
}
const conditionNames = { pristine: "Pristine", average: "Average", needs_work: "Needs work", abandoned: "Abandoned" };
async function showProperty(identity) {
  try {
    const response = await fetch(`/api/v1/properties/${encodeURIComponent(identity)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("property unavailable");
    const property = await response.json();
    $("selectedProperty").textContent = property.summary.property_identity;
    const tag = property.summary.condition ? `${conditionNames[property.summary.condition]} · ${property.summary.score}/10` : "Not yet rated";
    $("selectedPropertySummary").textContent = `${tag} · ${stageNames[property.summary.stage] || "Saved"} · ${property.summary.action_count} saved action${property.summary.action_count === 1 ? "" : "s"}`;
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
let savedProperties = [];
let visibleProperties = 25;
function renderProperties() {
  const query = $("propertySearch").value.trim().toLowerCase();
  const stage = $("propertyStageFilter").value;
  const matches = savedProperties.filter(property => (!query || property.property_identity.toLowerCase().includes(query)) && (!stage || property.stage === stage));
  const displayed = matches.slice(0, visibleProperties);
  $("propertyResults").textContent = matches.length ? `Showing ${displayed.length} of ${matches.length} matching saved home${matches.length === 1 ? "" : "s"}.` : "No saved homes match this search.";
  const list = $("propertyList");
  list.replaceChildren(...displayed.map(property => {
    const item = document.createElement("button");
    item.className = "property-row";
    item.type = "button";
    const identity = document.createElement("strong");
    identity.textContent = property.property_identity;
    const detail = document.createElement("span");
    detail.textContent = `${property.condition ? `${conditionNames[property.condition]} · ${property.score}/10` : "Not yet rated"} · ${stageNames[property.stage] || "Saved"}`;
    item.append(identity, detail);
    item.addEventListener("click", () => showProperty(property.property_identity));
    return item;
  }));
  $("moreProperties").hidden = displayed.length >= matches.length;
}
function renderPipeline() {
  const activeStages = new Set(["reached_out", "waiting_for_reply", "in_conversation", "contractor_offer", "realtor_referral", "closed"]);
  $("pipelineSaved").textContent = String(savedProperties.length);
  $("pipelineReached").textContent = String(savedProperties.filter(property => activeStages.has(property.stage)).length);
  $("pipelineConversation").textContent = String(savedProperties.filter(property => property.stage === "in_conversation").length);
  $("pipelineOffer").textContent = String(savedProperties.filter(property => property.stage === "contractor_offer").length);
  $("pipelineClosed").textContent = String(savedProperties.filter(property => property.stage === "closed").length);
}
async function refreshProperties() {
  const button = $("refreshProperties");
  button.disabled = true;
  try {
    const response = await fetch("/api/v1/properties", { cache: "no-store" });
    if (!response.ok) throw new Error("properties unavailable");
    const { properties } = await response.json();
    savedProperties = properties;
    visibleProperties = 25;
    $("propertyCount").textContent = `${properties.length} saved`;
    renderProperties();
    renderPipeline();
    drawCoverageMap();
    if (!properties.length) $("propertiesDetail").textContent = "No tagged homes yet. Add one while parked or as a passenger.";
    else $("propertiesDetail").textContent = "Search, filter, or open a tagged house to update it.";
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
  const note = $("note").value.trim();
  if (!identity) return toast("Enter the home address before saving its tag.");
  submit.disabled = true;
  submit.textContent = "Saving tag…";
  try {
    const condition = document.querySelector('input[name="condition"]:checked')?.value;
    const tag = { condition, score: Number($("propertyScore").value) };
    if (!condition || !Number.isInteger(tag.score)) throw new Error("invalid tag");
    const position = await new Promise((resolve, reject) => navigator.geolocation?.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12_000, maximumAge: 15_000 }) || reject(new Error("location unavailable")));
    tag.latitude = position.coords.latitude;
    tag.longitude = position.coords.longitude;
    enqueue(action("property_saved", identity, {}));
    enqueue(action("note_added", identity, { note: privateTagNote(tag) }));
    if (note) enqueue(action("note_added", identity, { note }));
    $("captureForm").reset();
    $("propertyScore").value = "5";
    $("propertyScoreValue").value = "5";
    $("propertyScoreValue").textContent = "5";
    $("locationStatus").textContent = "When you save, Five Pointes automatically adds a private map star at your current location. Use this only while parked or as a passenger.";
    refreshStatus();
    toast("Tagged house saved. Ready for the next one.");
    await sync();
  } catch {
    $("locationStatus").textContent = "Five Pointes could not get a current location, so it did not save this tag. Check browser location permission and try again while parked or as a passenger.";
    toast("Location is needed to save this tagged home.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Save and Tag This House";
  }
});
$("propertyScore").addEventListener("input", () => { $("propertyScoreValue").value = $("propertyScore").value; $("propertyScoreValue").textContent = $("propertyScore").value; });
$("syncNow").addEventListener("click", sync);
function activateDashboard(view) {
  document.querySelectorAll("[data-dashboard-view]").forEach(item => item.classList.toggle("active", item.dataset.dashboardView === view));
  document.querySelectorAll("[data-dashboard-panel]").forEach(panel => { panel.hidden = panel.dataset.dashboardPanel !== view; });
  if (view === "map") { drawCoverageMap(); refreshCoverageFromCompletedDrives(); }
  if (view === "properties" || view === "pipeline") refreshProperties();
}
document.querySelectorAll("[data-dashboard-view]").forEach(button => button.addEventListener("click", () => activateDashboard(button.dataset.dashboardView)));
$("refreshProperties").addEventListener("click", refreshProperties);
$("propertySearch").addEventListener("input", () => { visibleProperties = 25; renderProperties(); });
$("propertyStageFilter").addEventListener("change", () => { visibleProperties = 25; renderProperties(); });
$("moreProperties").addEventListener("click", () => { visibleProperties += 25; renderProperties(); });
function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
$("exportProperties").addEventListener("click", async () => {
  const button = $("exportProperties");
  button.disabled = true;
  button.textContent = "Preparing…";
  try {
    const response = await fetch("/api/v1/properties", { cache: "no-store" });
    if (!response.ok) throw new Error("saved homes unavailable");
    const { properties } = await response.json();
    const rows = [["property_identity", "stage", "action_count", "last_activity_at"], ...properties.map(property => [property.property_identity, property.stage, property.action_count, property.last_activity_at])];
    const file = new Blob([rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(file);
    link.download = `five-pointes-saved-homes-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    $("exportDetail").textContent = `${properties.length} saved home${properties.length === 1 ? "" : "s"} downloaded as a vendor-neutral CSV.`;
  } catch {
    $("exportDetail").textContent = "The saved-home export is unavailable right now. Your homes remain private in this app.";
  } finally {
    button.disabled = false;
    button.textContent = "Download saved homes CSV";
  }
});
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
  { path: "/maps/grosse-pointe.geojson", city: "Grosse Pointe" }, { path: "/maps/grosse-pointe-farms.geojson", city: "Farms" }, { path: "/maps/grosse-pointe-park.geojson", city: "Park" },
  { path: "/maps/grosse-pointe-shores.geojson", city: "Shores" }, { path: "/maps/grosse-pointe-woods.geojson", city: "Woods" },
];
let streetSegments;

async function roads() {
  if (streetSegments) return streetSegments;
  const collections = await Promise.all(STREET_FILES.map(async source => {
    const response = await fetch(source.path, { cache: "force-cache" });
    if (!response.ok) throw new Error("map data unavailable");
    return { source, collection: await response.json() };
  }));
  streetSegments = collections.flatMap(({ source, collection }) => (collection.features || []).flatMap((feature, featureIndex) => {
    const geometry = feature.geometry || {};
    const name = feature.properties?.name || "Unnamed street";
    return (geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : []).map((coordinates, lineIndex) => ({ name, city: source.city, id: `${source.city}:${featureIndex}:${lineIndex}`, coordinates }));
  }));
  return streetSegments;
}

function roadSegmentKey(road, index) { return `${road.id || road.name}|${index}`; }
function coveragePercent(coverage) { return coverage.totalMeters ? `${((coverage.coveredMeters / coverage.totalMeters) * 100).toFixed(1)}%` : "—"; }
function coverageFromStoredSegments(segmentIds, streetLines) {
  const seen = new Set();
  let totalMeters = 0, coveredMeters = 0;
  for (const road of streetLines) {
    for (let index = 1; index < road.coordinates.length; index += 1) {
      const first = road.coordinates[index - 1], second = road.coordinates[index];
      const duplicateKey = [first, second].map(point => point.map(value => Number(value).toFixed(7)).join(",")).sort().join("|");
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);
      const latitude = (first[1] + second[1]) / 2;
      const [start, end] = [first, second].map(point => [point[0] * 111_320 * Math.cos(latitude * Math.PI / 180), point[1] * 110_540]);
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      totalMeters += length;
      if (segmentIds.has(roadSegmentKey(road, index))) coveredMeters += length;
    }
  }
  return { totalMeters: Math.round(totalMeters), coveredMeters: Math.round(coveredMeters) };
}
function renderStoredCoverageStats(segmentIds, streetLines) {
  $("overallCoverage").textContent = coveragePercent(coverageFromStoredSegments(segmentIds, streetLines));
  [["Grosse Pointe", "grossePointeCoverage"], ["Farms", "farmsCoverage"], ["Park", "parkCoverage"], ["Shores", "shoresCoverage"], ["Woods", "woodsCoverage"]].forEach(([city, target]) => {
    $(target).textContent = coveragePercent(coverageFromStoredSegments(segmentIds, streetLines.filter(road => road.city === city)));
  });
}
function renderCoverageStats(routePaths, streetLines) {
  const overall = previewCoverage(routePaths, streetLines);
  $("overallCoverage").textContent = coveragePercent(overall);
  [["Grosse Pointe", "grossePointeCoverage"], ["Farms", "farmsCoverage"], ["Park", "parkCoverage"], ["Shores", "shoresCoverage"], ["Woods", "woodsCoverage"]].forEach(([city, target]) => {
    $(target).textContent = coveragePercent(previewCoverage(routePaths, streetLines.filter(road => road.city === city)));
  });
  return overall;
}
async function persistCoveragePreview(coverage) {
  if (!coverage.covered.size) return;
  try {
    await fetch("/api/v1/coverage-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ segments: [...coverage.covered] }) });
  } catch {
    // The live route and its local coverage preview remain available even if
    // the derived-history write is temporarily unavailable.
  }
}
async function refreshCoverageHistory() {
  try {
    const [response, streetLines] = await Promise.all([fetch("/api/v1/coverage-preview", { cache: "no-store" }), roads()]);
    if (!response.ok) throw new Error("coverage history unavailable");
    const { segments } = await response.json();
    for (const segment of segments) storedCoverageSegments.add(segment);
    renderStoredCoverageStats(storedCoverageSegments, streetLines);
    drawCoverageMap();
  } catch {
    // The map can still calculate a current-drive preview after it loads.
  }
}

let storedCoverageSegments = new Set();
let selectedMapCity = "all";
let selectedRoutePaths = [];
const mapViewport = { scale: 1, x: 0, y: 0 };
const activePointers = new Map();

function coverageMapBounds(roadLines) {
  const points = roadLines.flatMap(road => road.coordinates);
  const longitudes = points.map(point => point[0]), latitudes = points.map(point => point[1]);
  const padX = Math.max((Math.max(...longitudes) - Math.min(...longitudes)) * 0.06, 0.0005);
  const padY = Math.max((Math.max(...latitudes) - Math.min(...latitudes)) * 0.06, 0.0005);
  return { west: Math.min(...longitudes) - padX, east: Math.max(...longitudes) + padX, south: Math.min(...latitudes) - padY, north: Math.max(...latitudes) + padY };
}
function coverageMapProjector(bounds, width, height) {
  const spanX = Math.max(bounds.east - bounds.west, 0.0001), spanY = Math.max(bounds.north - bounds.south, 0.0001);
  const scale = Math.min(width / spanX, height / spanY), usedWidth = spanX * scale, usedHeight = spanY * scale;
  return point => [(width - usedWidth) / 2 + (point[0] - bounds.west) * scale, (height - usedHeight) / 2 + (bounds.north - point[1]) * scale];
}
function transformedMapPoint(point, width, height) { return [width / 2 + (point[0] - width / 2) * mapViewport.scale + mapViewport.x, height / 2 + (point[1] - height / 2) * mapViewport.scale + mapViewport.y]; }
function drawMapStar(context, x, y) {
  context.save(); context.translate(x, y); context.beginPath();
  for (let index = 0; index < 10; index += 1) { const angle = -Math.PI / 2 + index * Math.PI / 5, radius = index % 2 ? 3.5 : 8, px = Math.cos(angle) * radius, py = Math.sin(angle) * radius; if (index) context.lineTo(px, py); else context.moveTo(px, py); }
  context.closePath(); context.fillStyle = "#f6b73c"; context.fill(); context.lineWidth = 2; context.strokeStyle = "#684400"; context.stroke(); context.restore();
}
async function drawCoverageMap() {
  const canvas = $("routeMap");
  if (!canvas) return;
  const width = canvas.clientWidth || 600, height = width * 0.6, pixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * pixelRatio); canvas.height = Math.round(height * pixelRatio);
  const context = canvas.getContext("2d"); context.scale(pixelRatio, pixelRatio); context.fillStyle = "#f4f7fb"; context.fillRect(0, 0, width, height);
  let allRoads;
  try { allRoads = await roads(); } catch { return; }
  const visibleRoads = selectedMapCity === "all" ? allRoads : allRoads.filter(road => road.city === selectedMapCity);
  if (!visibleRoads.length) return;
  const baseProject = coverageMapProjector(coverageMapBounds(visibleRoads), width, height);
  const project = point => transformedMapPoint(baseProject(point), width, height);
  context.lineCap = "round"; context.strokeStyle = "#c5d0df"; context.lineWidth = 1.25;
  for (const road of visibleRoads) { context.beginPath(); road.coordinates.forEach((point, index) => { const [x, y] = project(point); if (index) context.lineTo(x, y); else context.moveTo(x, y); }); context.stroke(); }
  context.strokeStyle = "#16a56b"; context.lineWidth = 3;
  for (const road of visibleRoads) for (let index = 1; index < road.coordinates.length; index += 1) {
    if (!storedCoverageSegments.has(roadSegmentKey(road, index))) continue;
    const [x1, y1] = project(road.coordinates[index - 1]), [x2, y2] = project(road.coordinates[index]); context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke();
  }
  if (selectedRoutePaths.length) {
    context.strokeStyle = "#2d6df6"; context.lineWidth = 3; context.lineJoin = "round";
    for (const route of selectedRoutePaths) { context.beginPath(); route.forEach((point, index) => { const [x, y] = project(point); if (index) context.lineTo(x, y); else context.moveTo(x, y); }); context.stroke(); }
  }
  for (const property of savedProperties) {
    if (!Array.isArray(property.location) || property.location.length !== 2) continue;
    const [x, y] = project(property.location);
    if (x >= -12 && x <= width + 12 && y >= -12 && y <= height + 12) drawMapStar(context, x, y);
  }
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
      if (!coverage.covered.has(roadSegmentKey(road, index))) continue;
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
    option.textContent = `${new Date(session.started_at).toLocaleString()} — ${readableDistance(session.sampled_distance_meters)}`;
    return option;
  }));
  $("routeSelector").hidden = sessions.length < 1;
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
    selectedRoutePaths = [route.coordinates];
    $("routeDetail").textContent = "One historical drive is shown in blue. Close this section to return to the coverage-first view.";
    await drawCoverageMap();
  } catch {
    $("routeDetail").textContent = "The private route is unavailable right now. Nothing was shared outside this app.";
  } finally {
    button.disabled = false;
    button.textContent = "Show selected route";
  }
}
$("loadRoute").addEventListener("click", loadSelectedRoute);
$("driveHistory").addEventListener("toggle", async event => {
  if (!event.currentTarget.open) {
    selectedRoutePaths = [];
    $("routeDetail").textContent = "Drag to pan. Pinch or scroll to zoom. Bright green is already covered; blue-gray is still to cover; gold stars are tagged homes.";
    return drawCoverageMap();
  }
  try { await loadRouteSessions(); }
  catch { $("routeDetail").textContent = "Historical drives are unavailable right now. Your coverage map is unchanged."; }
});
async function refreshCoverageFromCompletedDrives() {
  try {
    await loadRouteSessions();
    const sessionIds = [...$("routeSession").options].map(option => option.value).filter(Boolean);
    const routes = await Promise.all(sessionIds.map(async session => {
      const response = await fetch(`/api/v1/recorders/latest-route?session=${encodeURIComponent(session)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("route unavailable");
      return response.json();
    }));
    const completedRoutes = routes.filter(route => route.coordinates.length >= 2);
    if (!completedRoutes.length) return;
    const streetLines = await roads();
    const coverage = renderCoverageStats(completedRoutes.map(route => route.coordinates), streetLines);
    void persistCoveragePreview(coverage);
    for (const segment of coverage.covered) storedCoverageSegments.add(segment);
    renderStoredCoverageStats(storedCoverageSegments, streetLines);
    await drawCoverageMap();
  } catch {
    // Existing persisted coverage remains visible if a fresh route cannot load.
  }
}
document.querySelectorAll("[data-map-city]").forEach(button => button.addEventListener("click", () => {
  selectedMapCity = button.dataset.mapCity;
  mapViewport.scale = 1; mapViewport.x = 0; mapViewport.y = 0;
  document.querySelectorAll("[data-map-city]").forEach(item => item.classList.toggle("active", item === button));
  drawCoverageMap();
}));
const mapCanvas = $("routeMap");
function mapPointer(event) { const rect = mapCanvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
mapCanvas.addEventListener("pointerdown", event => { activePointers.set(event.pointerId, mapPointer(event)); mapCanvas.setPointerCapture(event.pointerId); });
mapCanvas.addEventListener("pointermove", event => {
  if (!activePointers.has(event.pointerId)) return;
  const next = mapPointer(event), previous = activePointers.get(event.pointerId), before = [...activePointers.entries()]; activePointers.set(event.pointerId, next);
  if (activePointers.size === 1) { mapViewport.x += next.x - previous.x; mapViewport.y += next.y - previous.y; drawCoverageMap(); }
  if (activePointers.size === 2) {
    const oldPoints = before.map(([id, point]) => id === event.pointerId ? previous : point), newPoints = [...activePointers.values()];
    const oldDistance = Math.hypot(oldPoints[0].x - oldPoints[1].x, oldPoints[0].y - oldPoints[1].y), newDistance = Math.hypot(newPoints[0].x - newPoints[1].x, newPoints[0].y - newPoints[1].y);
    if (oldDistance > 0) { mapViewport.scale = Math.min(10, Math.max(1, mapViewport.scale * newDistance / oldDistance)); drawCoverageMap(); }
  }
});
["pointerup", "pointercancel"].forEach(name => mapCanvas.addEventListener(name, event => activePointers.delete(event.pointerId)));
mapCanvas.addEventListener("wheel", event => { event.preventDefault(); mapViewport.scale = Math.min(10, Math.max(1, mapViewport.scale * (event.deltaY < 0 ? 1.16 : 1 / 1.16))); drawCoverageMap(); }, { passive: false });
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
refreshTrackerSignal();
refreshCoverageHistory();
activateDashboard("map");
refreshCoverageFromCompletedDrives();
setInterval(() => { if (document.visibilityState === "visible") refreshTrackerSignal(); }, 15_000);
