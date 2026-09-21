import assert from "node:assert/strict";
import { parseCsv, planCsvText } from "../private_app/import_preflight.mjs";

assert.deepEqual(parseCsv('APN,County,State,Address\n"A, 1",Wayne,MI,"1 Main St"\n'), [["APN", "County", "State", "Address"], ["A, 1", "Wayne", "MI", "1 Main St"]]);
const plan = await planCsvText("Parcel ID,County,State,Address\n100-1,Wayne,MI,1 Main St\n100-1,Wayne,MI,1 Main St\n,Wayne,MI,\n", "approved synthetic source");
assert.equal(plan.accepted, 1);
assert.equal(plan.rejected, 2);
assert.equal(plan.review_required, 0);
assert.equal(plan.records[0].identity_key, "MI:WAYNE:1001");
assert.match(plan.source_fingerprint, /^[a-f0-9]{16}$/);
console.log("import preflight contract: passed");
