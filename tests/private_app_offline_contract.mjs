import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../private_app/app.js", import.meta.url), "utf8");

assert.match(app, /writeQueue\(queue\);/);
assert.match(app, /function syncQueuedCapturesWhenOnline\(\)/);
assert.match(app, /navigator\.onLine && readQueue\(\)\.length/);
assert.match(app, /window\.addEventListener\("online", syncQueuedCapturesWhenOnline\)/);
assert.match(app, /syncQueuedCapturesWhenOnline\(\);\nrefreshProperties\(\);/);

console.log("private app offline queue contract: passed");
