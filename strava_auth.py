#!/usr/bin/env python3
"""Manual Strava OAuth flow (no localhost server needed).

Usage:
    export STRAVA_CLIENT_SECRET=...
    python strava_auth.py --athlete seth
    python strava_auth.py --athlete claire

Prints an authorize URL; you open it, approve, and paste the full redirect
URL back. Tokens are exchanged and saved to tokens/<athlete>.json (0600).
One Strava API app covers both athletes.
"""
import argparse
import json
import os
import sys
import time
import urllib.parse

import requests
import yaml

BASE = os.path.dirname(os.path.abspath(__file__))


def load_config():
    with open(os.path.join(BASE, "config.yaml")) as f:
        return yaml.safe_load(f)


def save_tokens(athlete, token_payload):
    cfg = load_config()
    tokens_dir = os.path.join(BASE, cfg["paths"]["tokens_dir"])
    os.makedirs(tokens_dir, exist_ok=True)
    path = os.path.join(tokens_dir, f"{athlete}.json")
    data = {
        "access_token": token_payload["access_token"],
        "refresh_token": token_payload["refresh_token"],
        "expires_at": token_payload["expires_at"],
        "athlete_id": token_payload.get("athlete", {}).get("id"),
    }
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(path, 0o600)
    return path


def client_id():
    """Strava client ID: STRAVA_CLIENT_ID env var first, config.yaml fallback.
    The client ID is not a secret (it appears in the OAuth authorize URL)."""
    env = os.environ.get("STRAVA_CLIENT_ID")
    if env:
        return env
    return str(load_config()["strava"]["client_id"])


def load_tokens(athlete):
    """Return (token_dict, source) for athlete.

    Source is "file" when tokens/<athlete>.json exists (local runs),
    "env" when <ATHLETE>_REFRESH_TOKEN is set (GitHub Actions),
    or (None, None) when the athlete has not authorized yet.
    """
    cfg = load_config()
    path = os.path.join(BASE, cfg["paths"]["tokens_dir"], f"{athlete}.json")
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f), "file"
    rt = os.environ.get(f"{athlete.upper()}_REFRESH_TOKEN")
    if rt:
        return {
            "access_token": os.environ.get(f"{athlete.upper()}_ACCESS_TOKEN", ""),
            "refresh_token": rt,
            "expires_at": float(os.environ.get(f"{athlete.upper()}_EXPIRES_AT", "0") or 0),
            "athlete_id": None,
        }, "env"
    return None, None


def record_rotated_token(athlete, tok):
    """Stash a freshly rotated refresh token so the Actions workflow can
    write it back to repo secrets. The file is gitignored and deleted by
    the workflow after use; the value is never printed."""
    path = os.environ.get(
        "ROTATED_TOKENS_PATH", os.path.join(BASE, "data", "rotated_tokens.json")
    )
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = {}
    if os.path.exists(path):
        with open(path) as f:
            data = json.load(f)
    data[athlete] = {
        "refresh_token": tok["refresh_token"],
        "expires_at": tok["expires_at"],
    }
    with open(path, "w") as f:
        json.dump(data, f)
    os.chmod(path, 0o600)


def refresh(athlete):
    """Return a valid access token for athlete, refreshing if needed."""
    cfg = load_config()
    cid = client_id()
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET")
    if not client_secret:
        raise RuntimeError("STRAVA_CLIENT_SECRET env var is not set")
    tok, source = load_tokens(athlete)
    if tok is None:
        raise RuntimeError(
            f"no tokens for {athlete}: run strava_auth.py --athlete {athlete} first"
        )
    if tok["expires_at"] - time.time() > 300:
        return tok["access_token"]
    r = requests.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": cid,
            "client_secret": client_secret,
            "grant_type": "refresh_token",
            "refresh_token": tok["refresh_token"],
        },
        timeout=30,
    )
    r.raise_for_status()
    new = r.json()
    tok.update(
        {
            "access_token": new["access_token"],
            "refresh_token": new["refresh_token"],
            "expires_at": new["expires_at"],
        }
    )
    if source == "file":
        path = os.path.join(BASE, cfg["paths"]["tokens_dir"], f"{athlete}.json")
        with open(path, "w") as f:
            json.dump(tok, f, indent=2)
        os.chmod(path, 0o600)
    else:
        # CI: tokens came from env vars — record the rotated refresh token
        # so the workflow can persist it back to repo secrets.
        record_rotated_token(athlete, tok)
    print(f"[{athlete}] access token refreshed")
    return tok["access_token"]


def main():
    parser = argparse.ArgumentParser(description="Authorize a Strava athlete (manual OAuth).")
    parser.add_argument("--athlete", required=True, choices=["seth", "claire"])
    args = parser.parse_args()

    cfg = load_config()
    cid = client_id()
    if not cid or "YOUR_STRAVA" in cid:
        sys.exit("Set the STRAVA_CLIENT_ID env var or strava.client_id in config.yaml "
                 "(from strava.com/settings/api).")
    client_secret = os.environ.get("STRAVA_CLIENT_SECRET")
    if not client_secret:
        sys.exit("Set the STRAVA_CLIENT_SECRET environment variable first.")

    params = urllib.parse.urlencode(
        {
            "client_id": cid,
            "redirect_uri": cfg["strava"]["redirect_uri"],
            "response_type": "code",
            "scope": "activity:read_all",  # needed to read private ("Only You") activities
            "approval_prompt": "auto",
        }
    )
    url = f"https://www.strava.com/oauth/authorize?{params}"
    print(f"Authorizing athlete: {args.athlete}")
    print()
    print("1. Open this URL in your browser:")
    print("   " + url)
    print()
    print("2. Click Authorize. Your browser will land on a localhost URL that fails to load.")
    print("3. Copy the FULL URL from the address bar (it contains ?code=...) and paste it here.")
    print()
    pasted = input("redirect URL: ").strip().strip("'\"")
    query = urllib.parse.urlparse(pasted).query
    code = urllib.parse.parse_qs(query).get("code", [None])[0]
    if not code:
        sys.exit("No ?code= found in that URL. Make sure you pasted the full redirect URL.")

    r = requests.post(
        "https://www.strava.com/oauth/token",
        data={
            "client_id": cid,
            "client_secret": client_secret,
            "code": code,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    if r.status_code != 200:
        sys.exit(f"Token exchange failed ({r.status_code}): {r.text[:300]}")
    payload = r.json()
    path = save_tokens(args.athlete, payload)
    name = (payload.get("athlete") or {}).get("firstname", "?")
    print(f"Saved {path} (mode 0600) for {name}.")


if __name__ == "__main__":
    main()
