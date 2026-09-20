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
    assert "replace-after-private-provisioning" in text
    assert "00000000-0000-0000-0000-000000000000" in text
    assert "account_id" not in text
    assert "ALLOWED_EMAILS" in text
    assert 'directory = "./private_app"' in text


def test_private_schema_and_readme_keep_gps_storage_private():
    schema = (ROOT / "cloudflare" / "migrations" / "0001_private_household.sql").read_text()
    readme = (ROOT / "cloudflare" / "README.md").read_text().lower()
    assert "household_actions" in schema
    assert "no public bucket endpoint" in readme
    assert "approval" in readme


def test_import_plan_api_only_accepts_sanitized_staging_fields():
    worker = (ROOT / "cloudflare" / "worker.js").read_text()
    schema = (ROOT / "cloudflare" / "migrations" / "0002_import_plan_staging.sql").read_text()
    assert "POST\" && url.pathname === \"/api/v1/import-plans\"" in worker
    assert "source_fields_present" in worker
    assert "identity_key" in worker
    assert "getImportPlan" in worker
    assert "GET\" && importStatus" in worker
    assert "owner" not in schema.lower()
    assert "phone" not in schema.lower()
    assert "email" not in schema.lower()
    assert "import_plan_records" in schema


def test_private_phone_shell_is_not_part_of_the_public_pages_artifact():
    workflow = (ROOT / ".github" / "workflows" / "publish-prototype.yml").read_text()
    app = (ROOT / "private_app" / "app.js").read_text()
    service_worker = (ROOT / "private_app" / "service-worker.js").read_text()
    worker = (ROOT / "cloudflare" / "worker.js").read_text()
    assert "private_app" not in workflow
    assert "cp prototype.html public/index.html" in workflow
    assert 'fetch("/api/v1/actions"' in app
    assert "localStorage" in app
    assert 'url.pathname.startsWith("/api/")' in service_worker
    assert "env.ASSETS.fetch(request)" in worker
