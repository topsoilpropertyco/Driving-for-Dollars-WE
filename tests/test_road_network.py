"""Executable fixtures for the shared coverage and undriven road basis."""
from shapely.geometry import LineString, Polygon

from road_network import canonical_feature_parts, canonical_network, covered_length, undriven_parts


def test_partial_drive_does_not_complete_a_long_road():
    road = LineString([(0, 0), (1000, 0)])
    driven = LineString([(100, 0), (200, 0)]).buffer(1)
    # A round-ended 1 m buffer covers its 100 m centerline plus ~1 m at each
    # end.  The important invariant is that this is still a small interval,
    # never the entire 1 km street feature.
    assert 100 < covered_length([road], driven) < 103


def test_duplicate_geometry_counts_once_in_total_and_coverage():
    road = LineString([(0, 0), (1000, 0)])
    network = canonical_network([road, road])
    assert network.length == 1000
    assert covered_length([road, road], road.buffer(1)) == 1000


def test_divided_roads_remain_two_distinct_targets():
    eastbound = LineString([(0, 0), (1000, 0)])
    westbound = LineString([(0, 20), (1000, 20)])
    assert canonical_network([eastbound, westbound]).length == 2000
    assert covered_length([eastbound, westbound], eastbound.buffer(2)) == 1000


def test_crossing_roads_do_not_double_count_the_intersection_point():
    horizontal = LineString([(0, 0), (1000, 0)])
    vertical = LineString([(500, -500), (500, 500)])
    assert canonical_network([horizontal, vertical]).length == 2000


def test_driven_and_undriven_intervals_partition_the_network():
    road = LineString([(0, 0), (1000, 0)])
    buffer = LineString([(100, 0), (700, 0)]).buffer(1)
    remainder = sum(line.length for line in undriven_parts([road], buffer))
    assert abs(covered_length([road], buffer) + remainder - 1000) < 0.0001


def test_boundary_clip_attributes_only_the_inside_interval():
    road = LineString([(-100, 0), (100, 0)])
    boundary = Polygon([(0, -20), (100, -20), (100, 20), (0, 20)])
    assert road.intersection(boundary).length == 100


def test_duplicate_features_are_deduplicated_before_undriven_labels():
    road = LineString([(0, 0), (1000, 0)])
    parts = canonical_feature_parts([
        (road, {"name": "Example Road", "highway": "residential"}),
        (road, {"name": "Example Road", "highway": "residential"}),
    ])
    assert len(parts) == 1
    assert parts[0].line.length == 1000
