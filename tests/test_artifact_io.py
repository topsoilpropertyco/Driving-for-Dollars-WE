"""Regression tests for generated-artifact replacement safety."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from artifact_io import write_json_atomically, write_text_atomically


def test_atomic_json_replaces_only_a_complete_serialization():
    with TemporaryDirectory() as directory:
        output = Path(directory) / "coverage.json"
        output.write_text('{"previous": true}', encoding="utf-8")
        write_json_atomically(str(output), {"next": [1, 2]})
        assert json.loads(output.read_text(encoding="utf-8")) == {"next": [1, 2]}


def test_failed_serialization_preserves_the_previous_artifact_and_cleans_up():
    with TemporaryDirectory() as directory:
        output = Path(directory) / "coverage.json"
        output.write_text('{"previous": true}', encoding="utf-8")
        try:
            write_json_atomically(str(output), {"not_serializable": {1, 2}})
        except TypeError:
            pass
        else:
            raise AssertionError("expected serialization failure")
        assert output.read_text(encoding="utf-8") == '{"previous": true}'
        assert not list(Path(directory).glob(".building-*"))


def test_atomic_text_write_replaces_the_complete_dashboard():
    with TemporaryDirectory() as directory:
        output = Path(directory) / "dashboard.html"
        write_text_atomically(str(output), "<main>complete</main>")
        assert output.read_text(encoding="utf-8") == "<main>complete</main>"
