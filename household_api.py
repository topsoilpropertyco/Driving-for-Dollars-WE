"""Local WSGI API contract for the private household store.

This deliberately provides no listener or deployed credential. It lets the
future protected edge service reuse tested HTTP semantics while the current
repository exercises only synthetic, temporary SQLite databases.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from io import BytesIO
from typing import Callable
from urllib.parse import unquote

from household_actions import HouseholdAction, InvalidAction
from household_store import ingest_actions, property_summary, property_timeline


MAX_BODY_BYTES = 100_000


@dataclass(frozen=True)
class LocalApiConfig:
    """A synthetic local token, never a production authentication mechanism."""

    test_bearer_token: str


def _json_response(start_response, status: str, value: dict):
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    start_response(status, [("Content-Type", "application/json"), ("Content-Length", str(len(payload)))])
    return [payload]


def _request_json(environ):
    try:
        length = int(environ.get("CONTENT_LENGTH") or "0")
    except ValueError as exc:
        raise ValueError("invalid content length") from exc
    if length < 1 or length > MAX_BODY_BYTES:
        raise ValueError("invalid request size")
    raw = environ["wsgi.input"].read(length)
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid JSON body") from exc
    if not isinstance(value, dict):
        raise ValueError("JSON body must be an object")
    return value


def _action(value: dict) -> HouseholdAction:
    fields = {"event_id", "device_id", "sequence", "occurred_at", "kind", "property_identity", "payload"}
    if set(value) != fields:
        raise InvalidAction("action has unexpected fields")
    return HouseholdAction(**value)


def make_application(connection, config: LocalApiConfig):
    """Create a WSGI application; callers own the private DB connection."""

    def application(environ, start_response):
        method = environ.get("REQUEST_METHOD", "GET")
        path = environ.get("PATH_INFO", "")
        if method == "GET" and path == "/health":
            return _json_response(start_response, "200 OK", {"status": "synthetic-local-only"})
        if environ.get("HTTP_AUTHORIZATION") != f"Bearer {config.test_bearer_token}":
            return _json_response(start_response, "401 Unauthorized", {"error": "unauthorized"})
        try:
            if method == "POST" and path == "/v1/actions":
                body = _request_json(environ)
                values = body.get("actions")
                if not isinstance(values, list) or not values:
                    raise ValueError("actions must be a non-empty list")
                result = ingest_actions(connection, [_action(value) for value in values])
                return _json_response(start_response, "202 Accepted", {
                    "accepted_event_ids": result.accepted_event_ids,
                    "already_seen_event_ids": result.already_seen_event_ids,
                })
            prefix = "/v1/properties/"
            if method == "GET" and path.startswith(prefix):
                identity = unquote(path[len(prefix):])
                if not identity:
                    return _json_response(start_response, "404 Not Found", {"error": "not_found"})
                summary = property_summary(connection, identity)
                timeline = property_timeline(connection, identity)
                return _json_response(start_response, "200 OK", {
                    "summary": summary,
                    "timeline": [
                        {"event_id": item.event_id, "occurred_at": item.occurred_at,
                         "kind": item.kind, "payload": item.payload}
                        for item in timeline
                    ],
                })
        except (InvalidAction, ValueError, TypeError) as exc:
            return _json_response(start_response, "400 Bad Request", {"error": "invalid_request"})
        return _json_response(start_response, "404 Not Found", {"error": "not_found"})

    return application
