"""Static safety checks for the unprovisioned private deployment package."""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_worker_fails_closed_and_requires_access_identity_allow_list():
    text = (ROOT / "cloudflare" / "worker.js").read_text()
    assert "Cf-Access-Authenticated-User-Email" in text
    assert "ALLOWED_EMAILS" in text
    assert "unauthorized" in text
    assert "cache-control\": \"no-store" in text


def test_deployment_config_has_placeholders_not_real_resource_identifiers():
    text = (ROOT / "cloudflare" / "wrangler.toml").read_text()
    assert "REPLACE_AFTER_PRIVATE_PROVISIONING" in text
    assert "account_id" not in text
    assert "ALLOWED_EMAILS" in text


def test_private_schema_and_readme_keep_gps_storage_private():
    schema = (ROOT / "cloudflare" / "migrations" / "0001_private_household.sql").read_text()
    readme = (ROOT / "cloudflare" / "README.md").read_text().lower()
    assert "household_actions" in schema
    assert "no public bucket endpoint" in readme
    assert "approval" in readme
