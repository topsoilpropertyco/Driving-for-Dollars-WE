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
    assert 'directory = "../private_app"' in text
    assert "run_worker_first = true" in text


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


def test_private_capture_shell_prevents_double_taps_and_resets_after_a_local_capture():
    app = (ROOT / "private_app" / "app.js").read_text()
    page = (ROOT / "private_app" / "index.html").read_text()
    assert 'id="captureSubmit"' in page
    assert "if (submit.disabled) return" in app
    assert 'submit.textContent = "Saving…"' in app
    assert '$("captureForm").reset()' in app
    assert 'toast("Captured safely. Ready for the next home.")' in app


def test_private_phone_shell_has_an_iphone_home_screen_manifest_and_cached_icon():
    page = (ROOT / "private_app" / "index.html").read_text()
    manifest = (ROOT / "private_app" / "manifest.webmanifest").read_text()
    icon = (ROOT / "private_app" / "icon.svg").read_text()
    service_worker = (ROOT / "private_app" / "service-worker.js").read_text()
    assert 'rel="manifest" href="/manifest.webmanifest"' in page
    assert 'apple-mobile-web-app-capable' in page
    assert '"display": "standalone"' in manifest
    assert '<svg' in icon
    assert '"/manifest.webmanifest"' in service_worker
    assert '"/icon.svg"' in service_worker


def test_recorder_ingress_is_separate_from_household_access_and_has_no_read_route():
    ingress = (ROOT / "cloudflare" / "recorder_worker.js").read_text()
    migration = (ROOT / "cloudflare" / "migrations" / "0003_recorder_pilot.sql").read_text()
    config = (ROOT / "cloudflare" / "wrangler.recorder.toml").read_text()
    assert "token_hash" in ingress
    assert "recorder_devices" in ingress
    assert 'url.pathname === "/"' in ingress
    assert "return response(404)" in ingress
    assert "recorder_points" in migration
    assert "00000000-0000-0000-0000-000000000000" in config


def test_private_phone_shell_only_generates_recorder_setup_after_authenticated_bootstrap():
    page = (ROOT / "private_app" / "index.html").read_text()
    app = (ROOT / "private_app" / "app.js").read_text()
    assert 'id="prepareRecorder"' in page
    assert 'id="recorderConfig" hidden' in page
    assert 'fetch("/api/v1/recorders/bootstrap"' in app
    assert "navigator.clipboard.writeText" in app
    assert 'localStorage.setItem("recorder' not in app
