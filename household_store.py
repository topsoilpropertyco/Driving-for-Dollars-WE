"""Private SQLite persistence for household actions.

This module is intentionally local-only. It has no HTTP listener, no cloud
credentials, and no production data. The future protected service can use this
same transactional schema behind authenticated household access.
"""

from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from household_actions import HouseholdAction, QueueResult, validate_action


SCHEMA = """
CREATE TABLE IF NOT EXISTS household_actions (
    event_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    property_identity TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS household_actions_by_property
    ON household_actions (property_identity, occurred_at, event_id);
"""


def default_private_database_path(base: Path) -> Path:
    return base / "data" / "private" / "household.sqlite3"


def open_store(path: Path) -> sqlite3.Connection:
    """Open a local private store with foreign-safe, transactional settings."""
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA)
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA foreign_keys = ON")
    # New local private artifacts should not be group/world-readable.
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return connection


def ingest_actions(connection: sqlite3.Connection, actions) -> QueueResult:
    """Atomically persist validated actions; replayed event IDs are harmless."""
    validated = [validate_action(action) for action in actions]
    accepted, already_seen = [], []
    received_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    with connection:
        for action in validated:
            cursor = connection.execute(
                """INSERT OR IGNORE INTO household_actions
                   (event_id, device_id, sequence, occurred_at, kind,
                    property_identity, payload_json, received_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    action.event_id,
                    action.device_id,
                    action.sequence,
                    action.occurred_at,
                    action.kind,
                    action.property_identity,
                    json.dumps(dict(action.payload), separators=(",", ":")),
                    received_at,
                ),
            )
            (accepted if cursor.rowcount else already_seen).append(action.event_id)
    return QueueResult(tuple(accepted), tuple(already_seen))


def property_timeline(connection: sqlite3.Connection, property_identity: str):
    """Return an ordered, append-only household history for one property."""
    rows = connection.execute(
        """SELECT event_id, device_id, sequence, occurred_at, kind,
                  property_identity, payload_json
           FROM household_actions WHERE property_identity = ?
           ORDER BY occurred_at, event_id""",
        (property_identity,),
    ).fetchall()
    return [
        HouseholdAction(
            event_id=row["event_id"],
            device_id=row["device_id"],
            sequence=row["sequence"],
            occurred_at=row["occurred_at"],
            kind=row["kind"],
            property_identity=row["property_identity"],
            payload=json.loads(row["payload_json"]),
        )
        for row in rows
    ]


def property_summary(connection: sqlite3.Connection, property_identity: str) -> dict[str, object]:
    """Resolve a display summary without erasing its event history."""
    timeline = property_timeline(connection, property_identity)
    stage = "no_outreach"
    notes, outreach_methods = [], []
    for action in timeline:
        if action.kind == "stage_changed":
            stage = action.payload["stage"]
        elif action.kind == "note_added":
            notes.append(action.payload["note"])
        elif action.kind == "outreach_logged":
            outreach_methods.append(action.payload["method"])
    return {
        "property_identity": property_identity,
        "saved": any(action.kind == "property_saved" for action in timeline),
        "stage": stage,
        "notes": notes,
        "outreach_methods": outreach_methods,
        "action_count": len(timeline),
    }
