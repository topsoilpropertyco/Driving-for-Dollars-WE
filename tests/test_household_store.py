"""Transactional private-store fixtures using only temporary synthetic data."""
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory

from household_actions import HouseholdAction
from household_store import default_private_database_path, ingest_actions, open_store, property_summary, property_timeline


def action(event_id, kind="property_saved", payload={}):
    return HouseholdAction(
        event_id=event_id,
        device_id="synthetic-phone",
        sequence=1,
        occurred_at="2026-09-20T18:00:00Z",
        kind=kind,
        property_identity="MI:WAYNE:000123",
        payload=payload,
    )


def test_store_is_private_by_default_and_replays_are_idempotent():
    with TemporaryDirectory() as directory:
        path = default_private_database_path(Path(directory))
        store = open_store(path)
        saved = action("123e4567-e89b-12d3-a456-426614174000")
        first = ingest_actions(store, [saved])
        retry = ingest_actions(store, [saved])
        assert first.accepted_event_ids == (saved.event_id,)
        assert retry.already_seen_event_ids == (saved.event_id,)
        assert property_summary(store, saved.property_identity)["saved"] is True
        store.close()


def test_actions_preserve_note_outreach_and_stage_history():
    with TemporaryDirectory() as directory:
        store = open_store(Path(directory) / "private.sqlite3")
        events = [
            action("123e4567-e89b-12d3-a456-426614174000"),
            action("123e4567-e89b-12d3-a456-426614174001", "note_added", {"note": "Synthetic note"}),
            action("123e4567-e89b-12d3-a456-426614174002", "outreach_logged", {"method": "mail"}),
            action("123e4567-e89b-12d3-a456-426614174003", "stage_changed", {"stage": "in_conversation"}),
        ]
        ingest_actions(store, events)
        summary = property_summary(store, events[0].property_identity)
        assert summary == {
            "property_identity": "MI:WAYNE:000123",
            "saved": True,
            "stage": "in_conversation",
            "notes": ["Synthetic note"],
            "outreach_methods": ["mail"],
            "action_count": 4,
        }
        assert [event.kind for event in property_timeline(store, events[0].property_identity)] == [
            "property_saved", "note_added", "outreach_logged", "stage_changed"
        ]
        store.close()


def test_invalid_batch_leaves_no_partial_actions():
    with TemporaryDirectory() as directory:
        store = open_store(Path(directory) / "private.sqlite3")
        valid = action("123e4567-e89b-12d3-a456-426614174000")
        invalid = replace(action("123e4567-e89b-12d3-a456-426614174001", "stage_changed", {"stage": "bad"}))
        try:
            ingest_actions(store, [valid, invalid])
        except ValueError:
            pass
        else:
            raise AssertionError("invalid batch should be rejected")
        assert property_timeline(store, valid.property_identity) == []
        store.close()
