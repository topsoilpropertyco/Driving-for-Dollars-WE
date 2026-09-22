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
    assert 'caches.delete(key)' in service_worker
    assert 'five-pointes-private-shell-v3' in service_worker


def test_recorder_ingress_is_separate_from_household_access_and_has_no_read_route():
    ingress = (ROOT / "cloudflare" / "recorder_worker.js").read_text()
    migration = (ROOT / "cloudflare" / "migrations" / "0003_recorder_pilot.sql").read_text()
    config = (ROOT / "cloudflare" / "wrangler.recorder.toml").read_text()
    assert "token_hash" in ingress
    assert "recorder_devices" in ingress
    assert 'url.pathname === "/"' in ingress
    assert "return response(404)" in ingress
    assert "UPDATE recorder_devices SET revoked_at" in (ROOT / "cloudflare" / "worker.js").read_text()
    assert "recorder_points" in migration
    assert "00000000-0000-0000-0000-000000000000" in config


def test_private_phone_shell_only_generates_recorder_setup_after_authenticated_bootstrap():
    page = (ROOT / "private_app" / "index.html").read_text()
    app = (ROOT / "private_app" / "app.js").read_text()
    assert 'id="prepareRecorder"' in page
    assert 'id="recorderConfig" hidden' in page
    assert 'id="recorderServer" type="password"' in page
    assert "do not share or screenshot" in page
    assert 'fetch("/api/v1/recorders/bootstrap"' in app
    assert 'fetch("/api/v1/recorders/status"' in app
    assert 'id="checkRecorder"' in page
    assert "navigator.clipboard.writeText" in app
    assert 'localStorage.setItem("recorder' not in app


def test_private_route_map_uses_authenticated_api_and_bundled_street_context():
    worker = (ROOT / "cloudflare" / "worker.js").read_text()
    app = (ROOT / "private_app" / "app.js").read_text()
    page = (ROOT / "private_app" / "index.html").read_text()
    assert 'url.pathname === "/api/v1/recorders/latest-route"' in worker
    assert 'url.pathname === "/api/v1/recorders/sessions"' in worker
    assert 'fetch("/api/v1/recorders/latest-route"' in app
    assert 'fetch("/api/v1/recorders/sessions"' in app
    assert 'id="routeMap"' in page
    assert 'id="coverageDetail"' in page
    assert 'id="loadHouseholdCoverage"' in page
    assert "No third-party map service receives it." in page
    assert (ROOT / "private_app" / "maps" / "grosse-pointe.geojson").is_file()
    assert 'import { previewCoverage } from "./coverage_preview.mjs"' in app
    assert (ROOT / "private_app" / "coverage_preview.mjs").is_file()
    assert '"/coverage_preview.mjs"' in (ROOT / "private_app" / "service-worker.js").read_text()
    assert "self.skipWaiting()" in (ROOT / "private_app" / "service-worker.js").read_text()
    assert 'completed household drive' in app


def test_private_phone_shell_has_a_recent_signal_indicator_not_a_claimed_switch_state():
    app = (ROOT / "private_app" / "app.js").read_text()
    page = (ROOT / "private_app" / "index.html").read_text()
    assert 'id="trackerSignal"' in page
    assert 'id="trackerState"' in page
    assert "recent private location report" in page
    assert "TRACKER_FRESH_MS" in app
    assert 'fetch("/api/v1/recorders/status"' in app
    assert 'setInterval(() => { if (document.visibilityState === "visible") refreshTrackerSignal(); }, 15_000)' in app
    assert "Daycare drive tomorrow morning" in page
    assert "begins outside the bundled Grosse Pointe street area" in page
    assert "Three simple steps" in page
    assert "You do not create or copy recorder settings for each drive." in page
    assert "relativeAge" in app


def test_private_crm_list_is_authenticated_and_does_not_require_provider_data():
    worker = (ROOT / "cloudflare" / "worker.js").read_text()
    app = (ROOT / "private_app" / "app.js").read_text()
    page = (ROOT / "private_app" / "index.html").read_text()
    assert 'url.pathname === "/api/v1/properties"' in worker
    assert 'fetch("/api/v1/properties"' in app
    assert 'id="propertyStageForm"' in page
    assert 'id="propertyNoteForm"' in page
    assert 'id="propertyOutreachForm"' in page
    assert 'saveSelectedPropertyAction' in app
    assert 'id="exportProperties"' in page
    assert 'fetch("/api/v1/properties"' in app
    assert 'URL.createObjectURL' in app
    assert 'vendor-neutral CSV' in page
    assert 'id="propertyList"' in page
    assert 'id="propertyDetail" hidden' in page
    assert 'fetch(`/api/v1/properties/${encodeURIComponent(identity)}`' in app
    assert "No external property or owner data has been imported." in page
