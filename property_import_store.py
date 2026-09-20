"""Resumable, no-value import-plan staging for the private store.

The staging tables hold identities, row numbers, validation state, and source
field names only. Provider values (owner/contact information) are deliberately
not accepted here until the protected real-data importer is approved.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from uuid import uuid4

from property_import import ImportPlan


@dataclass(frozen=True)
class ImportProgress:
    import_id: str
    status: str
    total_records: int
    processed_records: int
    review_records: int


def _progress(connection: sqlite3.Connection, import_id: str) -> ImportProgress:
    run = connection.execute(
        "SELECT import_id, status FROM import_runs WHERE import_id = ?", (import_id,)
    ).fetchone()
    if run is None:
        raise ValueError("unknown import run")
    counts = connection.execute(
        """SELECT COUNT(*) AS total,
                  SUM(CASE WHEN status != 'queued' THEN 1 ELSE 0 END) AS processed,
                  SUM(CASE WHEN status = 'review_required' THEN 1 ELSE 0 END) AS review
           FROM import_plan_records WHERE import_id = ?""",
        (import_id,),
    ).fetchone()
    return ImportProgress(
        import_id=run["import_id"],
        status=run["status"],
        total_records=counts["total"] or 0,
        processed_records=counts["processed"] or 0,
        review_records=counts["review"] or 0,
    )


def begin_import_plan(connection: sqlite3.Connection, plan: ImportPlan) -> ImportProgress:
    """Create one idempotent staged run without storing any provider values."""
    existing = connection.execute(
        "SELECT import_id FROM import_runs WHERE source_name = ? AND source_fingerprint = ?",
        (plan.source_name, plan.source_fingerprint),
    ).fetchone()
    if existing:
        return _progress(connection, existing["import_id"])
    import_id = str(uuid4())
    created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    with connection:
        connection.execute(
            "INSERT INTO import_runs (import_id, source_name, source_fingerprint, status, created_at) VALUES (?, ?, ?, 'staged', ?)",
            (import_id, plan.source_name, plan.source_fingerprint, created_at),
        )
        connection.executemany(
            """INSERT INTO import_plan_records
               (import_id, row_number, identity_kind, identity_key, review_required, source_fields_json, status)
               VALUES (?, ?, ?, ?, ?, ?, 'queued')""",
            [
                (import_id, record.row_number, record.identity_kind, record.identity_key,
                 int(record.review_required), json.dumps(record.source_fields_present))
                for record in plan.records
            ],
        )
    return _progress(connection, import_id)


def advance_import_plan(connection: sqlite3.Connection, import_id: str, batch_size: int = 500) -> ImportProgress:
    """Advance a bounded review-safe batch; repeat until the run is ready."""
    if batch_size < 1 or batch_size > 5_000:
        raise ValueError("batch_size must be between 1 and 5000")
    rows = connection.execute(
        """SELECT row_number, review_required FROM import_plan_records
           WHERE import_id = ? AND status = 'queued' ORDER BY row_number LIMIT ?""",
        (import_id, batch_size),
    ).fetchall()
    with connection:
        for row in rows:
            status = "review_required" if row["review_required"] else "validated"
            connection.execute(
                "UPDATE import_plan_records SET status = ? WHERE import_id = ? AND row_number = ?",
                (status, import_id, row["row_number"]),
            )
        remaining = connection.execute(
            "SELECT COUNT(*) AS count FROM import_plan_records WHERE import_id = ? AND status = 'queued'",
            (import_id,),
        ).fetchone()["count"]
        if remaining == 0:
            connection.execute("UPDATE import_runs SET status = 'ready_for_review' WHERE import_id = ?", (import_id,))
    return _progress(connection, import_id)
