# Coverage model and quality gates

## Implemented baseline

The current geographic computation projects roads and tracks into UTM 16N,
buffers tracks by the configured distance, and measures the **length of the
canonical street network** that lies in that buffer. It does not mark an entire
feature driven merely because the track touches one end: only the intersecting
line length counts.

As of this checkpoint, `coverage.py` unions each city's street lines before
measuring either total or driven length. This prevents duplicated OSM geometry
from inflating the denominator or counting a duplicated segment twice. A
crossing is still just a zero-length overlap; parallel and divided roads remain
distinct lines.

## Shared road basis

`road_network.py` is now the shared geometry basis for `coverage.py` and
`undriven.py`. It deduplicates coincident source geometry, retains divided
roads, and assigns the surviving undriven interval a deterministic name/highway
provenance record. This makes aggregate coverage and the glowing-undriven layer
measure the same physical linework.

The next refinement before a real release is stable persisted segment IDs and
explicit city attribution on each canonical interval, so historical coverage
can be compared across OSM refreshes.

## Acceptance fixtures

The production geographic test suite must prove all of these with tiny
synthetic geometries:

1. A buffer touching only 30 m of a 1 km line reports about 30 m, not 1 km.
2. Two identical lines count once in both total and driven length.
3. A divided road's two separate centerlines remain separate coverage targets.
4. An intersection does not double-count shared node length.
5. A city boundary split attributes length only to the city-side interval.
6. A GPS point near a parallel street cannot cover both streets unless its
   accuracy/route-matching evidence supports that result.
7. The union of driven and undriven canonical intervals equals the canonical
   total within a small numerical tolerance.

## Output safety

`coverage.json` now uses a same-directory temporary file and atomic replacement.
An interrupted coverage run therefore leaves the last complete artifact in
place rather than replacing it with partial JSON. The same rule must be applied
to undriven and dashboard artifacts before automated production runs are
enabled.
