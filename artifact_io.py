"""Failure-safe local artifact writing shared by pipeline stages."""

from __future__ import annotations

import json
import os
import tempfile


def _replace_atomically(path, write):
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".building-", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            write(handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def write_json_atomically(path, value):
    _replace_atomically(path, lambda handle: json.dump(value, handle, indent=2))


def write_text_atomically(path, value):
    _replace_atomically(path, lambda handle: handle.write(value))
