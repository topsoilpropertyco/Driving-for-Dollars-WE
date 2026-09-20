"""Offline action validation and idempotency fixtures; no private data."""
from dataclasses import replace

from household_actions import HouseholdAction, InvalidAction, reconcile_actions, validate_action


BASE = HouseholdAction(
    event_id="123e4567-e89b-12d3-a456-426614174000",
    device_id="synthetic-phone-a",
    sequence=1,
    occurred_at="2026-09-20T18:00:00Z",
    kind="property_saved",
    property_identity="MI:WAYNE:000123",
    payload={},
)


def test_valid_actions_for_each_household_operation():
    validate_action(BASE)
    validate_action(replace(BASE, event_id="123e4567-e89b-12d3-a456-426614174001", kind="note_added", payload={"note": "Synthetic note"}))
    validate_action(replace(BASE, event_id="123e4567-e89b-12d3-a456-426614174002", kind="stage_changed", payload={"stage": "in_conversation"}))
    validate_action(replace(BASE, event_id="123e4567-e89b-12d3-a456-426614174003", kind="outreach_logged", payload={"method": "mail"}))


def test_stage_and_note_validation_are_strict():
    invalid = replace(BASE, kind="stage_changed", payload={"stage": "unknown"})
    try:
        validate_action(invalid)
    except InvalidAction:
        pass
    else:
        raise AssertionError("unknown stage must be rejected")
    invalid = replace(BASE, kind="note_added", payload={"note": "   "})
    try:
        validate_action(invalid)
    except InvalidAction:
        pass
    else:
        raise AssertionError("empty note must be rejected")


def test_offline_retries_are_idempotent_but_two_phones_can_both_submit():
    second_phone = replace(BASE, event_id="123e4567-e89b-12d3-a456-426614174004", device_id="synthetic-phone-b")
    first = reconcile_actions([BASE, second_phone])
    assert first.accepted_event_ids == (BASE.event_id, second_phone.event_id)
    retry = reconcile_actions([BASE, second_phone], seen_event_ids=first.accepted_event_ids)
    assert retry.accepted_event_ids == ()
    assert retry.already_seen_event_ids == first.accepted_event_ids
