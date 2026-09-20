"""Tests for the no-write property import planning boundary."""
from pathlib import Path

from property_import import plan_csv, plan_file, plan_rows


ROOT = Path(__file__).resolve().parents[1]


def test_synthetic_csv_is_classified_without_echoing_private_values():
    plan = plan_csv(ROOT / "tests" / "fixtures" / "synthetic_properties.csv", "synthetic-provider")
    assert plan.summary() == {
        "source_name": "synthetic-provider",
        "source_fingerprint": plan.source_fingerprint,
        "recognized_headers": ["address", "apn", "city", "county", "state", "unit"],
        "accepted": 3,
        "rejected": 2,
        "rejections_by_code": {"duplicate_identity_in_file": 1, "missing_stable_identity": 1},
        "review_required": 1,
    }
    assert plan.records[0].identity_kind == "apn"
    assert plan.records[2].identity_kind == "address_candidate"
    assert plan.records[2].review_required is True


def test_header_aliases_and_duplicate_apns_are_normalized_safely():
    rows = [
        {"Parcel Number": "00-12", "County": " Wayne ", "State": "mi"},
        {"Parcel Number": "0012", "County": "wayne", "State": "MI"},
    ]
    plan = plan_rows("fixture", rows[0].keys(), rows)
    assert len(plan.records) == 1
    assert plan.records[0].identity_key == "MI:WAYNE:0012"
    assert plan.rejected[0].code == "duplicate_identity_in_file"


def test_address_only_identity_is_never_auto_matched():
    rows = [{"Property Address": "1 Main St", "City": "Grosse Pointe", "State": "MI"}]
    plan = plan_rows("fixture", rows[0].keys(), rows)
    assert plan.records[0].identity_kind == "address_candidate"
    assert plan.records[0].review_required is True


def test_fingerprint_changes_when_the_normalized_identity_changes():
    headers = ("APN", "County", "State")
    first = plan_rows("fixture", headers, [{"APN": "1", "County": "Wayne", "State": "MI"}])
    second = plan_rows("fixture", headers, [{"APN": "2", "County": "Wayne", "State": "MI"}])
    assert first.source_fingerprint != second.source_fingerprint


def test_synthetic_xlsx_uses_the_same_identity_and_review_rules_as_csv():
    plan = plan_file(ROOT / "tests" / "fixtures" / "synthetic_properties.xlsx", "synthetic-provider")
    assert plan.summary()["accepted"] == 3
    assert plan.summary()["rejected"] == 2
    assert plan.summary()["review_required"] == 1
