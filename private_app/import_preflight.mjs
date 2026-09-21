// Local-only CSV preflight. It produces sanitized import-plan metadata and
// never uploads, logs, or persists file values.
const HEADER_ALIASES = {
  apn: ["apn", "apn id", "parcel", "parcel id", "parcel number", "tax id"],
  address: ["address", "property address", "site address", "street address"],
  unit: ["unit", "unit #", "apt", "apartment", "suite"],
  city: ["city", "property city"], state: ["state", "property state"],
  zip: ["zip", "zip code", "postal code"], county: ["county", "property county"],
};

function text(value) { return String(value || "").trim().replace(/\s+/g, " "); }
function header(value) { return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " "); }
function key(value) { return text(value).toUpperCase().replace(/[^A-Z0-9]/g, ""); }

export function parseCsv(csvText) {
  const rows = [[]]; let field = ""; let quoted = false;
  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];
    if (quoted && character === '"' && csvText[index + 1] === '"') { field += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (!quoted && character === ",") { rows.at(-1).push(field); field = ""; continue; }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && csvText[index + 1] === "\n") index += 1;
      rows.at(-1).push(field); field = "";
      if (rows.at(-1).some(value => text(value))) rows.push([]);
      continue;
    }
    field += character;
  }
  if (quoted) throw new Error("The CSV has an unclosed quoted field.");
  rows.at(-1).push(field);
  return rows.filter(row => row.some(value => text(value)));
}

function resolveHeaders(headers) {
  const available = new Map(headers.map((value, index) => [header(value), index]));
  return Object.fromEntries(Object.entries(HEADER_ALIASES).flatMap(([name, aliases]) => {
    const index = aliases.map(alias => available.get(alias)).find(Number.isInteger);
    return index === undefined ? [] : [[name, index]];
  }));
}

async function fingerprint(material) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export async function planCsvText(csvText, sourceName) {
  const rows = parseCsv(csvText.replace(/^\uFEFF/, ""));
  if (!rows.length) throw new Error("The CSV has no header row.");
  const headings = rows[0].map(text);
  if (!headings.some(Boolean)) throw new Error("The CSV has no usable header row.");
  const fields = resolveHeaders(headings);
  const records = [], rejected = [], seen = new Set();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]; const value = name => row[fields[name]] || "";
    const apn = key(value("apn")), county = key(value("county")), state = key(value("state"));
    const address = key(value("address")), unit = key(value("unit")), city = key(value("city"));
    let identityKind, identityKey, reviewRequired;
    if (apn && county && state) { identityKind = "apn"; identityKey = `${state}:${county}:${apn}`; reviewRequired = false; }
    else if (address && city && state) { identityKind = "address_candidate"; identityKey = `${state}:${city}:${address}:${unit}`; reviewRequired = true; }
    else { rejected.push({ row_number: index + 1, code: "missing_stable_identity" }); continue; }
    const duplicate = `${identityKind}:${identityKey}`;
    if (seen.has(duplicate)) { rejected.push({ row_number: index + 1, code: "duplicate_identity_in_file" }); continue; }
    seen.add(duplicate);
    records.push({ row_number: index + 1, identity_kind: identityKind, identity_key: identityKey, review_required: reviewRequired, source_fields_present: headings.filter((name, headingIndex) => text(row[headingIndex]) && name).map(header).sort() });
  }
  const safeSource = text(sourceName);
  if (!safeSource) throw new Error("Name the approved source before planning the file.");
  const material = [safeSource, ...headings.map(header).sort(), ...records.map(record => `${record.row_number}:${record.identity_kind}:${record.identity_key}:${Number(record.review_required)}`), ...rejected.map(row => `${row.row_number}:${row.code}`)].join("\u001f");
  return {
    source_name: safeSource, source_fingerprint: await fingerprint(material), recognized_headers: Object.keys(fields).sort(),
    accepted: records.length, rejected: rejected.length, review_required: records.filter(record => record.review_required).length,
    records,
  };
}
