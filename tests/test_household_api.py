"""WSGI contract tests; all data and credentials are synthetic."""
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory

from household_api import LocalApiConfig, make_application
from household_store import open_store


TOKEN = "synthetic-test-token"


def call(app, method, path, body=None, token=TOKEN):
    encoded = json.dumps(body).encode("utf-8") if body is not None else b""
    captured = {}
    def start_response(status, headers):
        captured["status"] = status
        captured["headers"] = headers
    output = app({
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "CONTENT_LENGTH": str(len(encoded)),
        "CONTENT_TYPE": "application/json",
        "HTTP_AUTHORIZATION": f"Bearer {token}" if token else "",
        "wsgi.input": io.BytesIO(encoded),
    }, start_response)
    return captured["status"], json.loads(b"".join(output))


def synthetic_action():
    return {
        "event_id": "123e4567-e89b-12d3-a456-426614174000",
        "device_id": "synthetic-phone",
        "sequence": 1,
        "occurred_at": "2026-09-20T18:00:00Z",
        "kind": "property_saved",
        "property_identity": "MI:WAYNE:000123",
        "payload": {},
    }


def test_health_is_public_but_private_routes_require_local_test_auth():
    with TemporaryDirectory() as directory:
        store = open_store(Path(directory) / "private.sqlite3")
        app = make_application(store, LocalApiConfig(TOKEN))
        assert call(app, "GET", "/health", token="")[0] == "200 OK"
        assert call(app, "POST", "/v1/actions", {"actions": [synthetic_action()]}, token="wrong")[0] == "401 Unauthorized"
        store.close()


def test_action_ingest_is_idempotent_and_property_read_is_scoped():
    with TemporaryDirectory() as directory:
        store = open_store(Path(directory) / "private.sqlite3")
        app = make_application(store, LocalApiConfig(TOKEN))
        body = {"actions": [synthetic_action()]}
        status, result = call(app, "POST", "/v1/actions", body)
        assert status == "202 Accepted"
        assert result["accepted_event_ids"] == [body["actions"][0]["event_id"]]
        status, result = call(app, "POST", "/v1/actions", body)
        assert status == "202 Accepted"
        assert result["already_seen_event_ids"] == [body["actions"][0]["event_id"]]
        status, result = call(app, "GET", "/v1/properties/MI%3AWAYNE%3A000123")
        assert status == "200 OK"
        assert result["summary"]["saved"] is True
        assert len(result["timeline"]) == 1
        store.close()


def test_api_rejects_unexpected_action_fields_without_writing():
    with TemporaryDirectory() as directory:
        store = open_store(Path(directory) / "private.sqlite3")
        app = make_application(store, LocalApiConfig(TOKEN))
        bad = synthetic_action() | {"unknown": "field"}
        status, result = call(app, "POST", "/v1/actions", {"actions": [bad]})
        assert status == "400 Bad Request"
        assert result == {"error": "invalid_request"}
        assert call(app, "GET", "/v1/properties/MI%3AWAYNE%3A000123")[1]["timeline"] == []
        store.close()
