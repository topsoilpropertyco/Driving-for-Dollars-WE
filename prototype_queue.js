/* Synthetic-only offline queue behavior for the public UX prototype.
 * It uses browser localStorage and deliberately has no fetch/XHR/network code.
 */
(() => {
  const storageKey = "five-pointes.synthetic-offline-queue.v1";
  const $ = (id) => document.getElementById(id);
  let queue = [];

  try {
    queue = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (!Array.isArray(queue)) queue = [];
  } catch (_) {
    queue = [];
  }

  function eventId() {
    return globalThis.crypto?.randomUUID?.() || `synthetic-${Date.now()}-${Math.random()}`;
  }

  function persist() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(queue));
      return true;
    } catch (_) {
      return false;
    }
  }

  function queueAction(kind, property, payload = {}) {
    queue.push({
      event_id: eventId(),
      device_id: "synthetic-browser",
      sequence: queue.length + 1,
      occurred_at: new Date().toISOString(),
      kind,
      property_identity: property,
      payload,
    });
  }

  function renderQueue() {
    const count = queue.length;
    $("queueCount").textContent = count;
    $("queueDetail").textContent = count
      ? `${count} synthetic action${count === 1 ? "" : "s"} stored on this device`
      : "No synthetic actions waiting on this device";
    $("clearSyntheticQueue").disabled = count === 0;
  }

  const originalSave = $("save").onclick;
  $("save").onclick = () => {
    const property = $("sheetAddress").textContent;
    const stage = $("stage").value;
    const note = $("note").value.trim();
    queueAction("property_saved", property);
    if (stage !== "Saved / no outreach") queueAction("stage_changed", property, {stage});
    if (note) queueAction("note_added", property, {note});
    const stored = persist();
    originalSave();
    renderQueue();
    toast(stored
      ? `Saved locally — ${queue.length} synthetic action${queue.length === 1 ? "" : "s"} queued`
      : "Saved in this page only — device storage is unavailable");
  };

  const dataGrid = document.querySelector("#data .data-grid");
  const queueCard = document.createElement("section");
  queueCard.className = "card";
  queueCard.innerHTML = `
    <h2>Offline capture queue</h2>
    <p class="sub" id="queueDetail"></p>
    <div class="mini"><i style="background:var(--blue)"></i><div><b id="queueCount">0</b><small>synthetic actions queued</small></div></div>
    <button class="secondary" id="clearSyntheticQueue">Clear synthetic queue</button>
    <p class="source" style="margin:10px 0 0">Prototype only: stored in this browser, never sent anywhere.</p>`;
  dataGrid.append(queueCard);
  $("clearSyntheticQueue").onclick = () => {
    queue = [];
    try { localStorage.removeItem(storageKey); } catch (_) { /* memory queue is already clear */ }
    renderQueue();
    toast("Synthetic queue cleared — no data was sent");
  };
  renderQueue();
})();
