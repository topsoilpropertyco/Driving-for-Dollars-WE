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
  $("syncNow").hidden = !queue.length;
  $("syncNow").textContent = "Sync queued captures now";
  $("syncDetail").textContent = message || (queue.length ? `${queue.length} tagged home action${queue.length === 1 ? "" : "s"} waiting safely on this phone. You can sync now, or it will retry automatically when online.` : "Tagged homes sync automatically when your phone is online. Nothing is waiting.");
  $("sync-title").textContent = queue.length ? "Captures waiting safely" : "Nothing to do";
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
  if (status.active_devices) {
    $("recorderDetail").textContent = "This iPhone is already configured. You do not need to press anything here. For a drive, use Traccar to turn Continuous tracking on before leaving and off after parking.";
    $("prepareRecorder").hidden = true;
  } else {
    $("recorderDetail").textContent = "No recorder is configured for this household yet. Set up a phone only when you want to add a new driving recorder.";
    $("prepareRecorder").hidden = false;
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
    toast(confirmed.size ? "Saved to your private household app." : "Nothing new was accepted yet.");
  } catch { refreshStatus("Secure sync is unavailable. Your captures remain queued on this phone."); }
  finally { $("syncNow").disabled = false; }
}
function syncQueuedCapturesWhenOnline() {
  if (navigator.onLine && readQueue().length) void sync();
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
  if (tag) return `${savedScoreSummary(tag)}${Number.isFinite(tag.latitude) ? " · map star" : ""}`;
  if (item.kind === "property_tagged") return `${savedScoreSummary(item.payload)}${Number.isFinite(item.payload.latitude) ? " · map star" : ""}`;
  if (item.kind === "stage_changed") return `Stage: ${stageNames[item.payload.stage] || "Updated"}`;
  if (item.kind === "note_added") return `Note: ${item.payload.note}`;
  if (item.kind === "outreach_logged") return `Outreach: ${item.payload.method}`;
  return "Updated";
}
const conditionNames = { pristine: "Pristine", average: "Average", needs_work: "Needs work", abandoned: "Abandoned" };
function savedScoreSummary(tag) {
  const scores = [`${conditionNames[tag.condition] || "House condition"} · ${tag.score}/10`];
  if (Number.isInteger(tag.home_excitement_score)) scores.push(`Home excitement ${tag.home_excitement_score}/10`);
  if (Number.isInteger(tag.neighborhood_excitement_score)) scores.push(`Neighborhood joy ${tag.neighborhood_excitement_score}/10`);
  return scores.join(" · ");
}
async function showProperty(identity) {
  try {
    const response = await fetch(`/api/v1/properties/${encodeURIComponent(identity)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("property unavailable");
    const property = await response.json();
    $("selectedProperty").textContent = property.summary.property_identity;
    const tag = property.summary.condition ? savedScoreSummary(property.summary) : "Not yet rated";
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
let addressSession = crypto.randomUUID();
let selectedAddress = null;
let addressSearchTimer;
function hideAddressSuggestions() { $("addressSuggestions").replaceChildren(); $("addressSuggestions").hidden = true; }
function setAddressSearchStatus(message = "") {
  const status = $("addressSearchStatus");
  status.textContent = message;
  status.hidden = !message;
}
function renderAddressSuggestions(suggestions) {
  const list = $("addressSuggestions");
  list.replaceChildren(...suggestions.map(suggestion => {
    const button = document.createElement("button");
    button.type = "button"; button.setAttribute("role", "option"); button.textContent = suggestion.address;
    button.addEventListener("click", () => selectAddressSuggestion(suggestion));
    return button;
  }));
  list.hidden = !suggestions.length;
}
async function selectAddressSuggestion(suggestion) {
  hideAddressSuggestions();
  setAddressSearchStatus();
  $("propertyIdentity").disabled = true;
  $("locationStatus").textContent = "Confirming selected address…";
  try {
    const response = await fetch(`/api/v1/address-place?place_id=${encodeURIComponent(suggestion.place_id)}&session=${encodeURIComponent(addressSession)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("address unavailable");
    const place = await response.json();
    selectedAddress = place;
    $("propertyIdentity").value = place.address;
    $("locationStatus").textContent = "Exact address selected. Saving will place the gold star at this address.";
  } catch {
    $("locationStatus").textContent = "That address could not be confirmed. You can keep typing or use your current location when saving.";
  } finally { $("propertyIdentity").disabled = false; }
}
$("propertyIdentity").addEventListener("input", () => {
  selectedAddress = null;
  clearTimeout(addressSearchTimer);
  const query = $("propertyIdentity").value.trim();
  if (query.length < 3) {
    hideAddressSuggestions();
    return setAddressSearchStatus();
  }
  addressSearchTimer = setTimeout(async () => {
    try {
      const response = await fetch(`/api/v1/address-autocomplete?q=${encodeURIComponent(query)}&session=${encodeURIComponent(addressSession)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("address search unavailable");
      const { suggestions } = await response.json();
      renderAddressSuggestions(suggestions);
      setAddressSearchStatus(suggestions.length ? "Choose a suggestion to place an exact address star." : "Keep typing to look for an address.");
    } catch {
      hideAddressSuggestions();
      setAddressSearchStatus("Address suggestions are not connected right now. Type the complete address; saving uses your current location for the map star.");
    }
  }, 250);
});
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
    detail.textContent = `${property.condition ? savedScoreSummary(property) : "Not yet rated"} · ${stageNames[property.stage] || "Saved"}`;
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
  void renderHomesDrivenPast();
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
    const tag = {
      condition,
      score: Number($("propertyScore").value),
      home_excitement_score: Number($("homeExcitementScore").value),
      neighborhood_excitement_score: Number($("neighborhoodExcitementScore").value),
    };
    if (!condition || ![tag.score, tag.home_excitement_score, tag.neighborhood_excitement_score].every(score => Number.isInteger(score) && score >= 1 && score <= 10)) throw new Error("invalid tag");
    if (selectedAddress && selectedAddress.address === identity) {
      tag.latitude = selectedAddress.latitude;
      tag.longitude = selectedAddress.longitude;
    } else {
      const position = await new Promise((resolve, reject) => navigator.geolocation?.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 12_000, maximumAge: 15_000 }) || reject(new Error("location unavailable")));
      tag.latitude = position.coords.latitude;
      tag.longitude = position.coords.longitude;
    }
    enqueue(action("property_saved", identity, {}));
    enqueue(action("note_added", identity, { note: privateTagNote(tag) }));
    if (note) enqueue(action("note_added", identity, { note }));
    $("captureForm").reset();
    selectedAddress = null;
    addressSession = crypto.randomUUID();
    hideAddressSuggestions();
    resetScoreControls();
    $("locationStatus").textContent = "Choose an address suggestion for an exact address star, or Five Pointes uses your current location when you save. Use this only while parked or as a passenger.";
    refreshStatus();
    toast("Tagged house saved. Ready for the next one.");
    await sync();
  } catch {
    $("locationStatus").textContent = "Five Pointes could not place the star, so it did not save this tag. Choose an address suggestion or check browser location permission, then try again.";
    toast("A confirmed address or current location is needed to save this home.");
  } finally {
    submit.disabled = false;
    submit.textContent = "Save this house";
  }
});
const scoreControls = [
  ["propertyScore", "propertyScoreValue"],
  ["homeExcitementScore", "homeExcitementScoreValue"],
  ["neighborhoodExcitementScore", "neighborhoodExcitementScoreValue"],
];
function resetScoreControls() {
  scoreControls.forEach(([inputId, outputId]) => { $(inputId).value = "5"; $(outputId).value = "5"; $(outputId).textContent = "5"; });
}
scoreControls.forEach(([inputId, outputId]) => $(inputId).addEventListener("input", () => { $(outputId).value = $(inputId).value; $(outputId).textContent = $(inputId).value; }));
$("syncNow").addEventListener("click", sync);
$("startFreshCoverage").addEventListener("click", async () => {
  const button = $("startFreshCoverage");
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    const response = await fetch("/api/v1/coverage-preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ segments: [], start_fresh_campaign: true }) });
    if (!response.ok) throw new Error("campaign unavailable");
    const result = await response.json();
    campaignStartedAt = result.campaign_started_at;
    storedCoverageSegments = new Set();
    $("freshCoverageCard").hidden = true;
    $("freshCoverageDetail").textContent = "Fresh coverage is active. Earlier private data is retained, not deleted.";
    coverageHistoryReady = refreshCoverageHistory();
    await coverageHistoryReady;
    await refreshCoverageFromCompletedDrives();
    toast("Fresh coverage map started. Nothing was deleted.");
  } catch {
    $("freshCoverageDetail").textContent = "Could not start a fresh coverage view. Earlier data is unchanged.";
    button.disabled = false;
    button.textContent = "Start fresh coverage map";
  }
});
function activateDashboard(view) {
  document.querySelectorAll("[data-dashboard-view]").forEach(item => item.classList.toggle("active", item.dataset.dashboardView === view));
  $("settingsShortcut").setAttribute("aria-pressed", String(view === "crm"));
  document.querySelectorAll("[data-dashboard-panel]").forEach(panel => { panel.hidden = panel.dataset.dashboardPanel !== view; });
  if (view === "map") { drawCoverageMap(); refreshCoverageFromCompletedDrives(); }
  if (view === "properties" || view === "pipeline") refreshProperties();
}
document.querySelectorAll("[data-dashboard-view]").forEach(button => button.addEventListener("click", () => activateDashboard(button.dataset.dashboardView)));
$("settingsShortcut").addEventListener("click", () => { activateDashboard("crm"); window.scrollTo({ top: 0, behavior: "smooth" }); });
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
    const rows = [["address", "stage", "action_count", "last_activity_at"], ...properties.map(property => [property.property_identity, property.stage, property.action_count, property.last_activity_at])];
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
  await saveSelectedPropertyAction("stage_changed", { stage: $("selectedPropertyStage").value }, "Stage saved to your private household app.");
});
$("propertyNoteForm").addEventListener("submit", async event => {
  event.preventDefault();
  const note = $("selectedPropertyNote").value.trim();
  if (!note) return toast("Write a note before saving it.");
  $("selectedPropertyNote").value = "";
  await saveSelectedPropertyAction("note_added", { note }, "Private note saved to your private household app.");
});
$("propertyOutreachForm").addEventListener("submit", async event => {
  event.preventDefault();
  await saveSelectedPropertyAction("outreach_logged", { method: $("selectedPropertyOutreach").value }, "Outreach saved to your private household app.");
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
let coverageHistoryReady = Promise.resolve();
let coverageHistoryRefresh = null;
async function refreshCoverageHistory() {
  if (coverageHistoryRefresh) return coverageHistoryRefresh;
  coverageHistoryRefresh = (async () => {
    try {
    const [response, streetLines] = await Promise.all([fetch("/api/v1/coverage-preview", { cache: "no-store" }), roads()]);
    if (!response.ok) throw new Error("coverage history unavailable");
    const history = await response.json();
    campaignStartedAt = history.campaign_started_at || null;
    const entries = Array.isArray(history.entries) ? history.entries : (history.segments || []).map(segment_id => ({ segment_id, last_seen_at: null }));
    const activeEntries = campaignStartedAt ? entries.filter(entry => Date.parse(entry.last_seen_at) >= Date.parse(campaignStartedAt)) : entries;
    storedCoverageSegments = new Set(activeEntries.map(entry => entry.segment_id));
    renderStoredCoverageStats(storedCoverageSegments, streetLines);
    void renderHomesDrivenPast();
    $("freshCoverageCard").hidden = Boolean(campaignStartedAt);
    if (campaignStartedAt) $("freshCoverageDetail").textContent = "Fresh coverage is active. Earlier private data is retained, not deleted.";
    drawCoverageMap();
    } catch {
      // The map can still calculate a current-drive preview after it loads.
    }
  })();
  try {
    return await coverageHistoryRefresh;
  } finally {
    coverageHistoryRefresh = null;
  }
}

let storedCoverageSegments = new Set();
let campaignStartedAt = null;
let selectedMapCity = "all";
let selectedRoutePaths = [];
const mapViewport = { scale: 1, x: 0, y: 0 };
const activePointers = new Map();
const parcelCityFiles = {
  "Grosse Pointe": "grosse-pointe",
  Farms: "grosse-pointe-farms",
  Park: "grosse-pointe-park",
  Shores: "grosse-pointe-shores",
  Woods: "grosse-pointe-woods",
};
const parcelLinesByCity = new Map();
const parcelLineRequests = new Map();
let homesDrivenPastRequest = null;

function parcelWithBounds(rings) {
  const points = rings.flat();
  return { rings, west: Math.min(...points.map(point => point[0])), east: Math.max(...points.map(point => point[0])), south: Math.min(...points.map(point => point[1])), north: Math.max(...points.map(point => point[1])) };
}

function pointMeters(point) { return [point[0] * 81_950, point[1] * 111_130]; }
function squaredDistanceToSegment(point, first, second) {
  const deltaX = second[0] - first[0], deltaY = second[1] - first[1];
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const fraction = lengthSquared ? Math.max(0, Math.min(1, ((point[0] - first[0]) * deltaX + (point[1] - first[1]) * deltaY) / lengthSquared)) : 0;
  const closestX = first[0] + fraction * deltaX, closestY = first[1] + fraction * deltaY;
  return (point[0] - closestX) ** 2 + (point[1] - closestY) ** 2;
}
function approximateHomesFromCoveredRoads(streetLines, segmentIds, parcels) {
  if (!segmentIds.size) return 0;
  const cellSize = 100, bufferMeters = 40, cells = new Map();
  for (const road of streetLines) for (let index = 1; index < road.coordinates.length; index += 1) {
    if (!segmentIds.has(roadSegmentKey(road, index))) continue;
    const first = pointMeters(road.coordinates[index - 1]), second = pointMeters(road.coordinates[index]);
    const minX = Math.floor((Math.min(first[0], second[0]) - bufferMeters) / cellSize), maxX = Math.floor((Math.max(first[0], second[0]) + bufferMeters) / cellSize);
    const minY = Math.floor((Math.min(first[1], second[1]) - bufferMeters) / cellSize), maxY = Math.floor((Math.max(first[1], second[1]) + bufferMeters) / cellSize);
    for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) {
      const key = `${x}:${y}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push([first, second]);
    }
  }
  let passed = 0;
  for (const parcel of parcels) {
    const point = pointMeters([(parcel.west + parcel.east) / 2, (parcel.south + parcel.north) / 2]);
    const key = `${Math.floor(point[0] / cellSize)}:${Math.floor(point[1] / cellSize)}`;
    if ((cells.get(key) || []).some(([first, second]) => squaredDistanceToSegment(point, first, second) <= bufferMeters ** 2)) passed += 1;
  }
  return passed;
}
async function renderHomesDrivenPast() {
  if (homesDrivenPastRequest) return homesDrivenPastRequest;
  homesDrivenPastRequest = (async () => {
    try {
      const streetLines = await roads();
      if (!storedCoverageSegments.size) {
        $("pipelineDrivenPast").textContent = "0";
        $("pipelineDrivenPastDetail").textContent = "No active Five Pointes street coverage has been recorded yet.";
        return;
      }
      const parcelGroups = await Promise.all(Object.keys(parcelCityFiles).map(loadParcelLines));
      const count = approximateHomesFromCoveredRoads(streetLines, storedCoverageSegments, parcelGroups.flat());
      $("pipelineDrivenPast").textContent = String(count);
      $("pipelineDrivenPastDetail").textContent = "Approximation from public lot outlines within 40 m of active covered streets. It is a helpful driving funnel, not a residential parcel census.";
    } catch {
      $("pipelineDrivenPast").textContent = "—";
      $("pipelineDrivenPastDetail").textContent = "The approximate driving reference is unavailable right now. Your saved-home counts are unchanged.";
    }
  })();
  try { return await homesDrivenPastRequest; } finally { homesDrivenPastRequest = null; }
}

async function loadParcelLines(city) {
  if (parcelLinesByCity.has(city)) return parcelLinesByCity.get(city);
  if (parcelLineRequests.has(city)) return parcelLineRequests.get(city);
  const request = fetch(`/maps/parcel-lines-${parcelCityFiles[city]}.json`, { cache: "force-cache" })
    .then(response => { if (!response.ok) throw new Error("parcel outlines unavailable"); return response.json(); })
    .then(data => {
      const parcels = Array.isArray(data.parcels) ? data.parcels.map(parcelWithBounds) : [];
      parcelLinesByCity.set(city, parcels);
      return parcels;
    })
    .finally(() => parcelLineRequests.delete(city));
  parcelLineRequests.set(city, request);
  return request;
}

function parcelCitiesForView() { return selectedMapCity === "all" ? Object.keys(parcelCityFiles) : [selectedMapCity]; }

function drawParcelLines(context, project, width, height) {
  if (mapViewport.scale < 6) return;
  const cities = parcelCitiesForView();
  const unavailable = cities.filter(city => !parcelLinesByCity.has(city));
  if (unavailable.length) {
    void Promise.all(unavailable.map(loadParcelLines)).then(() => drawCoverageMap()).catch(() => {});
  }
  const parcels = cities.flatMap(city => parcelLinesByCity.get(city) || []);
  if (!parcels.length) return;
  context.save();
  context.strokeStyle = "#8fa5bb";
  context.globalAlpha = 0.92;
  context.lineWidth = 0.8;
  for (const parcel of parcels) {
    const [topLeftX, topLeftY] = project([parcel.west, parcel.north]);
    const [bottomRightX, bottomRightY] = project([parcel.east, parcel.south]);
    if (Math.max(topLeftX, bottomRightX) < -2 || Math.min(topLeftX, bottomRightX) > width + 2 || Math.max(topLeftY, bottomRightY) < -2 || Math.min(topLeftY, bottomRightY) > height + 2) continue;
    for (const ring of parcel.rings) {
      context.beginPath();
      ring.forEach((point, index) => { const [x, y] = project(point); if (index) context.lineTo(x, y); else context.moveTo(x, y); });
      context.closePath();
      context.stroke();
    }
  }
  context.restore();
}

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
function drawStreetLabels(context, roadLines, project, width, height) {
  if (mapViewport.scale < 1.35) return;
  const candidates = new Map(), placed = [];
  const centerX = width / 2, centerY = height / 2;
  context.save();
  context.font = "700 12px system-ui, -apple-system, sans-serif";
  for (const road of roadLines) {
    if (!road.name || road.name === "Unnamed street") continue;
    const labelWidth = context.measureText(road.name).width + 18;
    for (let index = 1; index < road.coordinates.length; index += 1) {
      const [x1, y1] = project(road.coordinates[index - 1]), [x2, y2] = project(road.coordinates[index]);
      const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
      const length = Math.hypot(x2 - x1, y2 - y1);
      if (x < 28 || x > width - 28 || y < 12 || y > height - 12 || length < labelWidth) continue;
      const distance = Math.hypot(x - centerX, y - centerY), existing = candidates.get(road.name);
      if (!existing || distance / length < existing.distance / existing.length) candidates.set(road.name, { x, y, x1, y1, x2, y2, distance, length, name: road.name });
    }
  }
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const label of [...candidates.values()].sort((first, second) => first.distance - second.distance)) {
    const { x, y } = label;
    if (placed.some(existing => Math.hypot(existing.x - x, existing.y - y) < 54)) continue;
    placed.push({ x, y });
    let angle = Math.atan2(label.y2 - label.y1, label.x2 - label.x1);
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
    context.save(); context.translate(x, y); context.rotate(angle);
    context.lineWidth = 3;
    context.strokeStyle = "#f4f7fb";
    context.strokeText(label.name, 0, 0);
    context.fillStyle = "#43536c";
    context.fillText(label.name, 0, 0);
    context.restore();
  }
  context.restore();
}
async function drawCoverageMap() {
  const canvas = $("routeMap");
  if (!canvas) return;
  const width = canvas.clientWidth || 600, height = canvas.clientHeight || width * 0.6, pixelRatio = window.devicePixelRatio || 1;
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
  drawParcelLines(context, project, width, height);
  drawStreetLabels(context, visibleRoads, project, width, height);
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
  const height = canvas.clientHeight || width * 0.6;
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
let routeSessions = [];
let routeSessionsLoading = null;
function readableDistance(meters) {
  return meters >= 1609 ? `${(meters / 1609.344).toFixed(1)} mi` : `${Math.round(meters)} m`;
}
function readableDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  return minutes < 1 ? "under 1 min" : `${minutes} min`;
}
async function loadRouteSessions() {
  if (routeSessionsLoaded) return;
  if (routeSessionsLoading) return routeSessionsLoading;
  routeSessionsLoading = (async () => {
    const response = await fetch("/api/v1/recorders/sessions", { cache: "no-store" });
    if (!response.ok) throw new Error("drive history unavailable");
    const { sessions } = await response.json();
    routeSessions = sessions;
    const select = $("routeSession");
    select.replaceChildren(...sessions.map(session => {
      const option = document.createElement("option");
      option.value = session.session_id;
      option.textContent = `${new Date(session.started_at).toLocaleString()} — ${readableDistance(session.sampled_distance_meters)}`;
      return option;
    }));
    $("routeSelector").hidden = sessions.length < 1;
    routeSessionsLoaded = true;
  })();
  try {
    return await routeSessionsLoading;
  } finally {
    routeSessionsLoading = null;
  }
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
    $("routeDetail").textContent = "Drag to pan. Pinch or scroll deeply to zoom. Street names follow their street direction as you zoom in. Bright green is already covered; blue-gray is still to cover; gold stars are tagged homes.";
    return drawCoverageMap();
  }
  try { await loadRouteSessions(); }
  catch { $("routeDetail").textContent = "Historical drives are unavailable right now. Your coverage map is unchanged."; }
});
let completedDriveCoverageRefresh = null;
async function refreshCoverageFromCompletedDrives() {
  if (completedDriveCoverageRefresh) return completedDriveCoverageRefresh;
  completedDriveCoverageRefresh = (async () => {
    try {
    await coverageHistoryReady;
    await loadRouteSessions();
    const sessionIds = routeSessions
      .filter(session => !campaignStartedAt || Date.parse(session.started_at) >= Date.parse(campaignStartedAt))
      .map(session => session.session_id).filter(Boolean);
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
  })();
  try {
    return await completedDriveCoverageRefresh;
  } finally {
    completedDriveCoverageRefresh = null;
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
function zoomMapAt(x, y, factor) {
  const width = mapCanvas.clientWidth || 600, height = mapCanvas.clientHeight || width * 0.6;
  const nextScale = Math.min(2048, Math.max(1, mapViewport.scale * factor));
  const actualFactor = nextScale / mapViewport.scale;
  mapViewport.x = x - width / 2 - (x - width / 2 - mapViewport.x) * actualFactor;
  mapViewport.y = y - height / 2 - (y - height / 2 - mapViewport.y) * actualFactor;
  mapViewport.scale = nextScale;
}
let lastMapTap = null;
mapCanvas.addEventListener("pointerdown", event => {
  const point = mapPointer(event);
  if (event.pointerType === "touch" && lastMapTap && event.timeStamp - lastMapTap.time < 320 && Math.hypot(point.x - lastMapTap.x, point.y - lastMapTap.y) < 28) {
    zoomMapAt(point.x, point.y, 2.5);
    lastMapTap = null;
    drawCoverageMap();
  } else if (event.pointerType === "touch") lastMapTap = { ...point, time: event.timeStamp };
  activePointers.set(event.pointerId, point);
  mapCanvas.setPointerCapture(event.pointerId);
});
mapCanvas.addEventListener("pointermove", event => {
  if (!activePointers.has(event.pointerId)) return;
  const next = mapPointer(event), previous = activePointers.get(event.pointerId), before = [...activePointers.entries()]; activePointers.set(event.pointerId, next);
  if (activePointers.size === 1) { mapViewport.x += next.x - previous.x; mapViewport.y += next.y - previous.y; drawCoverageMap(); }
  if (activePointers.size === 2) {
    const oldPoints = before.map(([id, point]) => id === event.pointerId ? previous : point), newPoints = [...activePointers.values()];
    const oldDistance = Math.hypot(oldPoints[0].x - oldPoints[1].x, oldPoints[0].y - oldPoints[1].y), newDistance = Math.hypot(newPoints[0].x - newPoints[1].x, newPoints[0].y - newPoints[1].y);
    const oldCenter = { x: (oldPoints[0].x + oldPoints[1].x) / 2, y: (oldPoints[0].y + oldPoints[1].y) / 2 }, newCenter = { x: (newPoints[0].x + newPoints[1].x) / 2, y: (newPoints[0].y + newPoints[1].y) / 2 };
    if (oldDistance > 0) { zoomMapAt(oldCenter.x, oldCenter.y, newDistance / oldDistance); mapViewport.x += newCenter.x - oldCenter.x; mapViewport.y += newCenter.y - oldCenter.y; drawCoverageMap(); }
  }
});
["pointerup", "pointercancel"].forEach(name => mapCanvas.addEventListener(name, event => activePointers.delete(event.pointerId)));
mapCanvas.addEventListener("wheel", event => { event.preventDefault(); const point = mapPointer(event); zoomMapAt(point.x, point.y, event.deltaY < 0 ? 1.2 : 1 / 1.2); drawCoverageMap(); }, { passive: false });
$("zoomMapIn").addEventListener("click", () => { zoomMapAt(mapCanvas.clientWidth / 2, mapCanvas.clientHeight / 2, 2); drawCoverageMap(); });
$("zoomMapOut").addEventListener("click", () => { zoomMapAt(mapCanvas.clientWidth / 2, mapCanvas.clientHeight / 2, 0.5); drawCoverageMap(); });
$("resetMapView").addEventListener("click", () => { mapViewport.scale = 1; mapViewport.x = 0; mapViewport.y = 0; drawCoverageMap(); });
document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
  const input = $(button.dataset.copy);
  try { await navigator.clipboard.writeText(input.value); toast("Copied privately to this phone."); }
  catch { input.select(); toast("Select and copy the private value."); }
}));
window.addEventListener("online", syncQueuedCapturesWhenOnline);
window.addEventListener("offline", () => refreshStatus());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshTrackerSignal();
    syncQueuedCapturesWhenOnline();
  }
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});
refreshStatus();
syncQueuedCapturesWhenOnline();
refreshProperties();
refreshTrackerSignal();
coverageHistoryReady = refreshCoverageHistory();
activateDashboard("map");
refreshCoverageFromCompletedDrives();
setInterval(() => { if (document.visibilityState === "visible") refreshTrackerSignal(); }, 15_000);
