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
    toast(confirmed.size ? "Saved to your shared workspace." : "Nothing new was accepted yet.");
  } catch { refreshStatus("Secure sync is unavailable. Your captures remain queued on this phone."); }
  finally { $("syncNow").disabled = false; }
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
    return geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
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

function drawRoute(route, roadLines) {
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
  const project = projectRoute(route, width, height);
  context.strokeStyle = "#ccd5e3";
  context.lineWidth = 1;
  for (const road of roadLines) {
    if (!road.length) continue;
    context.beginPath();
    road.forEach((point, index) => {
      const [x, y] = project(point);
      if (index) context.lineTo(x, y); else context.moveTo(x, y);
    });
    context.stroke();
  }
  context.strokeStyle = "#2d6df6";
  context.lineWidth = 4;
  context.lineJoin = "round";
  context.lineCap = "round";
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

let routeSessionsLoaded = false;
async function loadRouteSessions() {
  if (routeSessionsLoaded) return;
  const response = await fetch("/api/v1/recorders/sessions", { cache: "no-store" });
  if (!response.ok) throw new Error("drive history unavailable");
  const { sessions } = await response.json();
  const select = $("routeSession");
  select.replaceChildren(...sessions.map(session => {
    const option = document.createElement("option");
    option.value = session.session_id;
    option.textContent = `${new Date(session.started_at).toLocaleString()} — ${session.point_count} points`;
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
    drawRoute(route.coordinates, await roads());
    $("routeCount").textContent = `${route.point_count} points`;
    $("routeDetail").textContent = `Latest drive: ${new Date(route.started_at).toLocaleString()} to ${new Date(route.ended_at).toLocaleTimeString()}. Blue is the private route; green is the start and red is the finish.`;
  } catch {
    $("routeDetail").textContent = "The private route is unavailable right now. Nothing was shared outside this app.";
  } finally {
    button.disabled = false;
    button.textContent = "Show selected route";
  }
}
$("loadRoute").addEventListener("click", loadSelectedRoute);
$("routeSession").addEventListener("change", loadSelectedRoute);
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
refreshTrackerSignal();
setInterval(() => { if (document.visibilityState === "visible") refreshTrackerSignal(); }, 15_000);
