"""Shared canonical-road operations for coverage and undriven outputs.

All callers pass projected, meter-based Shapely LineStrings.  The canonical
network deduplicates coincident geometry but keeps distinct parallel/divided
roads.  Feature canonicalization also retains one deterministic display
provenance record for each non-overlapping road interval.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping

from shapely.geometry import GeometryCollection, LineString
from shapely.ops import unary_union


def line_parts(geometry):
    """Return only usable line components from any Shapely geometry."""
    if geometry.is_empty:
        return []
    if geometry.geom_type == "LineString":
        return [geometry] if geometry.length else []
    if hasattr(geometry, "geoms"):
        parts = []
        for child in geometry.geoms:
            parts.extend(line_parts(child))
        return parts
    return []


def canonical_network(lines: Iterable[LineString]):
    """Return a deduplicated network suitable for all length measurements."""
    usable = [line for line in lines if line is not None and not line.is_empty and line.length]
    return unary_union(usable) if usable else GeometryCollection()


@dataclass(frozen=True)
class CanonicalRoadPart:
    line: LineString
    properties: Mapping[str, object]


def canonical_feature_parts(features: Iterable[tuple[LineString, Mapping[str, object]]]):
    """Deduplicate overlapping feature intervals while retaining display tags.

    Source order must never decide the public label, so feature geometry and
    name/highway tags are used as a deterministic ordering key.  At a crossing
    the shared point has zero length, so both roads remain intact.
    """
    items = [
        (line, dict(properties))
        for line, properties in features
        if line is not None and not line.is_empty and line.length
    ]
    items.sort(key=lambda item: (
        item[0].wkb_hex,
        str(item[1].get("name", "")),
        str(item[1].get("highway", "")),
    ))
    accepted = GeometryCollection()
    output: list[CanonicalRoadPart] = []
    for line, properties in items:
        fresh = line.difference(accepted)
        for part in line_parts(fresh):
            output.append(CanonicalRoadPart(part, properties))
        accepted = canonical_network([accepted, line])
    return output


def covered_length(lines: Iterable[LineString], track_buffer) -> float:
    """Measure exactly the canonical road length inside an accepted buffer."""
    network = canonical_network(lines)
    if network.is_empty or track_buffer is None or track_buffer.is_empty:
        return 0.0
    return network.intersection(track_buffer).length


def undriven_parts(lines: Iterable[LineString], track_buffer):
    """Return canonical road intervals outside the accepted track buffer."""
    network = canonical_network(lines)
    if network.is_empty:
        return []
    return line_parts(network if track_buffer is None else network.difference(track_buffer))
