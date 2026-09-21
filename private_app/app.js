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
document.querySelectorAll("[data-copy]").forEach(button => button.addEventListener("click", async () => {
  const input = $(button.dataset.copy);
  try { await navigator.clipboard.writeText(input.value); toast("Copied privately to this phone."); }
  catch { input.select(); toast("Select and copy the private value."); }
}));
window.addEventListener("online", sync);
window.addEventListener("offline", () => refreshStatus());
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});
refreshStatus();
