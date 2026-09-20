"""Static safety checks for the synthetic UX prototype."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_prototype_is_explicitly_synthetic_and_has_core_views():
    text = (ROOT / "prototype.html").read_text()
    for required in ("Synthetic prototype", "Explore", "Properties", "Funnel", "Data"):
        assert required in text


def test_prototype_has_no_external_recording_endpoint_or_private_track_data():
    text = (ROOT / "prototype.html").read_text().lower()
    for forbidden in ("strava.com", "owntracks", "traccar", "access_token", "refresh_token"):
        assert forbidden not in text


def test_docs_record_automatic_transfer_as_the_normal_flow():
    text = (ROOT / "docs" / "RECORDING_FEASIBILITY.md").read_text()
    assert "automatic" in text.lower()
    assert "recovery" in text.lower()
