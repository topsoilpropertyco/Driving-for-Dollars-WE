import assert from "node:assert/strict";
import { previewCoverage } from "../private_app/coverage_preview.mjs";

// About 111 m per latitude degree near the equator: this keeps the fixture
// legible while exercising the same meter conversion used by the app.
const route = [[0, 0], [0.001, 0]];
const roads = [
  { name: "Crossed", coordinates: [[0.0005, -0.001], [0.0005, 0.001]] },
  { name: "Nearby", coordinates: [[0, 0.00018], [0.001, 0.00018]] },
  { name: "Too far", coordinates: [[0, 0.0005], [0.001, 0.0005]] },
  { name: "Collinear but separate", coordinates: [[0.002, 0], [0.003, 0]] },
];

const result = previewCoverage(route, roads);
assert.deepEqual([...result.covered].sort(), ["Crossed|1", "Nearby|1"]);
assert.ok(result.coveredMeters > 0);
assert.ok(result.totalMeters > result.coveredMeters);

// A route with fewer than two reports cannot claim any street coverage.
assert.deepEqual(previewCoverage([[0, 0]], roads), { covered: new Set(), totalMeters: 0, coveredMeters: 0 });

console.log("coverage preview contract: passed");
