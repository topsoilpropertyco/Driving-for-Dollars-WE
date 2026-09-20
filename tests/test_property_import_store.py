"""Synthetic resumable import-plan staging, without provider values."""
from pathlib import Path
from tempfile import TemporaryDirectory

from household_store import open_store
from property_import import plan_csv
from property_import_store import advance_import_plan, begin_import_plan


ROOT = Path(__file__).resolve().parents[1]


def test_plan_staging_is_idempotent_and_resumes_in_bounded_batches():
    plan = plan_csv(ROOT / "tests" / "fixtures" / "synthetic_properties.csv", "synthetic-provider")
    with TemporaryDirectory() as directory:
        store = open_store(Path(directory) / "private.sqlite3")
        started = begin_import_plan(store, plan)
        assert started.status == "staged"
        assert started.total_records == 3
        assert begin_import_plan(store, plan).import_id == started.import_id
        first = advance_import_plan(store, started.import_id, batch_size=2)
        assert first.processed_records == 2
        assert first.status == "staged"
        finished = advance_import_plan(store, started.import_id, batch_size=2)
        assert finished == type(finished)(started.import_id, "ready_for_review", 3, 3, 1)
        store.close()


def test_import_plan_staging_never_persists_provider_values():
    plan = plan_csv(ROOT / "tests" / "fixtures" / "synthetic_properties.csv", "synthetic-provider")
    with TemporaryDirectory() as directory:
        store = open_store(Path(directory) / "private.sqlite3")
        started = begin_import_plan(store, plan)
        text = " ".join(str(row[0]) for row in store.execute("SELECT sql FROM sqlite_master WHERE type = 'table'").fetchall())
        assert "owner" not in text.lower()
        columns = [row[1] for row in store.execute("PRAGMA table_info(import_plan_records)").fetchall()]
        assert columns == ["import_id", "row_number", "identity_kind", "identity_key", "review_required", "source_fields_json", "status"]
        store.close()
