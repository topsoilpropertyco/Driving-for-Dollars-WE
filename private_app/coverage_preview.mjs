// A lightweight, browser-only coverage preview for the private pilot map.
// Coordinates are converted to a local meter approximation before comparing
// route and street segments. Nothing is persisted or sent to a map provider.
export function meterPoint(point, referenceLatitude) {
  return [point[0] * 111_320 * Math.cos(referenceLatitude * Math.PI / 180), point[1] * 110_540];
}

function pointSegmentDistance(point, start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  if (!dx && !dy) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const position = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(point[0] - (start[0] + position * dx), point[1] - (start[1] + position * dy));
}

function orientation(first, second, third) {
  return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

function onSegment(start, end, point) {
  return point[0] >= Math.min(start[0], end[0]) && point[0] <= Math.max(start[0], end[0]) && point[1] >= Math.min(start[1], end[1]) && point[1] <= Math.max(start[1], end[1]);
}

function segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd) {
  const a = orientation(firstStart, firstEnd, secondStart), b = orientation(firstStart, firstEnd, secondEnd);
  const c = orientation(secondStart, secondEnd, firstStart), d = orientation(secondStart, secondEnd, firstEnd);
  if (a === 0 && onSegment(firstStart, firstEnd, secondStart)) return true;
  if (b === 0 && onSegment(firstStart, firstEnd, secondEnd)) return true;
  if (c === 0 && onSegment(secondStart, secondEnd, firstStart)) return true;
  if (d === 0 && onSegment(secondStart, secondEnd, firstEnd)) return true;
  return ((a > 0 && b < 0) || (a < 0 && b > 0)) && ((c > 0 && d < 0) || (c < 0 && d > 0));
}

function segmentDistance(firstStart, firstEnd, secondStart, secondEnd) {
  if (segmentsIntersect(firstStart, firstEnd, secondStart, secondEnd)) return 0;
  return Math.min(pointSegmentDistance(firstStart, secondStart, secondEnd), pointSegmentDistance(firstEnd, secondStart, secondEnd), pointSegmentDistance(secondStart, firstStart, firstEnd), pointSegmentDistance(secondEnd, firstStart, firstEnd));
}

export function previewCoverage(routeOrPaths, roadLines, thresholdMeters = 30) {
  const routes = typeof routeOrPaths[0]?.[0] === "number" ? [routeOrPaths] : routeOrPaths;
  const points = routes.flat();
  if (points.length < 2) return { covered: new Set(), totalMeters: 0, coveredMeters: 0 };
  const referenceLatitude = points.reduce((total, point) => total + point[1], 0) / points.length;
  // Preserve drive boundaries: a straight line must never be inferred between
  // the finish of one drive and the start of another.
  const routeSegments = routes.flatMap(route => route.slice(1).map((point, index) => [meterPoint(route[index], referenceLatitude), meterPoint(point, referenceLatitude)]));
  const seen = new Set(), covered = new Set();
  let totalMeters = 0, coveredMeters = 0;
  for (const road of roadLines) {
    for (let index = 1; index < road.coordinates.length; index += 1) {
      const first = road.coordinates[index - 1], second = road.coordinates[index];
      const key = [first, second].map(point => point.map(value => Number(value).toFixed(7)).join(",")).sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const start = meterPoint(first, referenceLatitude), end = meterPoint(second, referenceLatitude);
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      totalMeters += length;
      if (routeSegments.some(([routeStart, routeEnd]) => segmentDistance(start, end, routeStart, routeEnd) <= thresholdMeters)) {
        covered.add(`${road.id || road.name}|${index}`);
        coveredMeters += length;
      }
    }
  }
  return { covered, totalMeters: Math.round(totalMeters), coveredMeters: Math.round(coveredMeters) };
}
