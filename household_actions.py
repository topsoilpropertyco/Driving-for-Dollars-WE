"""Offline-safe household property actions.

This is a provider-neutral domain layer, not a database or network client.
The later protected API and the phone's local queue will use these validation
rules so manual household actions remain idempotent and imports cannot alter
them.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Mapping
from uuid import UUID


STAGES = (
    "no_outreach",
    "reached_out",
    "waiting_for_reply",
    "in_conversation",
    "contractor_offer",
    "realtor_referral",
    "closed",
    "archived",
)
ACTION_KINDS = ("property_saved", "note_added", "stage_changed", "outreach_logged", "property_tagged")
CONDITIONS = ("pristine", "average", "needs_work", "abandoned")


class InvalidAction(ValueError):
    """An action is not safe to place into the local or server queue."""


@dataclass(frozen=True)
class HouseholdAction:
    event_id: str
    device_id: str
    sequence: int
    occurred_at: str
    kind: str
    property_identity: str
    payload: Mapping[str, object]


def _is_utc_timestamp(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() == timezone.utc.utcoffset(parsed)


def validate_action(action: HouseholdAction) -> HouseholdAction:
    try:
        UUID(action.event_id)
    except (ValueError, TypeError, AttributeError) as exc:
        raise InvalidAction("event_id must be a UUID") from exc
    if not action.device_id or len(action.device_id) > 128:
        raise InvalidAction("device_id is required")
    if not isinstance(action.sequence, int) or action.sequence < 1:
        raise InvalidAction("sequence must be a positive integer")
    if not _is_utc_timestamp(action.occurred_at):
        raise InvalidAction("occurred_at must be an ISO-8601 UTC timestamp")
    if action.kind not in ACTION_KINDS:
        raise InvalidAction("unsupported action kind")
    if not action.property_identity or len(action.property_identity) > 256:
        raise InvalidAction("property_identity is required")
    if not isinstance(action.payload, Mapping):
        raise InvalidAction("payload must be an object")
    if action.kind == "stage_changed":
        if set(action.payload) != {"stage"} or action.payload["stage"] not in STAGES:
            raise InvalidAction("stage_changed requires one supported stage")
    if action.kind == "note_added":
        note = action.payload.get("note")
        if set(action.payload) != {"note"} or not isinstance(note, str) or not note.strip():
            raise InvalidAction("note_added requires one non-empty note")
    if action.kind == "outreach_logged":
        method = action.payload.get("method")
        if set(action.payload) != {"method"} or not isinstance(method, str) or not method.strip():
            raise InvalidAction("outreach_logged requires one contact method")
    if action.kind == "property_tagged":
        expected = {"condition", "score"}
        has_location = "latitude" in action.payload or "longitude" in action.payload
        if has_location:
            expected |= {"latitude", "longitude"}
        if set(action.payload) != expected or action.payload.get("condition") not in CONDITIONS or not isinstance(action.payload.get("score"), int) or not 1 <= action.payload["score"] <= 10:
            raise InvalidAction("property_tagged requires a supported condition and score from 1 to 10")
        if has_location and (not isinstance(action.payload["latitude"], (int, float)) or not isinstance(action.payload["longitude"], (int, float)) or not -90 <= action.payload["latitude"] <= 90 or not -180 <= action.payload["longitude"] <= 180):
            raise InvalidAction("property_tagged location is invalid")
    if action.kind == "property_saved" and action.payload:
        raise InvalidAction("property_saved has no payload")
    return action


@dataclass(frozen=True)
class QueueResult:
    accepted_event_ids: tuple[str, ...]
    already_seen_event_ids: tuple[str, ...]


def reconcile_actions(actions, seen_event_ids=frozenset()) -> QueueResult:
    """Validate a batch and make retrying the same event harmless.

    The server will additionally persist an event-ID uniqueness constraint.
    Sequence ordering is per device and intentionally not global: two phones
    may be offline at the same time and must both be able to make progress.
    """
    seen = set(seen_event_ids)
    accepted, already_seen = [], []
    for action in actions:
        validate_action(action)
        if action.event_id in seen:
            already_seen.append(action.event_id)
        else:
            seen.add(action.event_id)
            accepted.append(action.event_id)
    return QueueResult(tuple(accepted), tuple(already_seen))
