# Implementation Checklist

## Current phase: synthetic prototype and contracts

- [x] Audit existing prototype and identify documentation gaps.
- [x] Consolidate product, privacy, recording, and geographic decisions.
- [x] Define automatic-recording feasibility contract and pilot criteria.
- [x] Build a synthetic-data mobile/desktop UX prototype.
- [x] Add a synthetic-only mobile preview deployment workflow.
- [x] Complete initial phone map review; real-map baseline approved for continued refinement.
- [x] Add an explicit private-sync gate and atomic private-cache writes.
- [x] Run synthetic privacy, import, and road fixtures automatically in CI.
- [x] Define and test the offline, idempotent household action contract.
- [x] Implement and test local transactional persistence for synthetic household actions.
- [x] Implement and test a local authenticated API contract over household persistence.
- [x] Build an unprovisioned private Cloudflare Worker/D1/R2 deployment package.
- [x] Exercise the private Worker import API against a synthetic D1 contract double.
- [x] Exercise the private Worker household-action API against a synthetic D1 contract double.
- [x] Provision the private D1 database, private R2 bucket, and fail-closed Worker shell.
- [x] Configure Cloudflare Access, one-time email PIN, and the two-household-member allow-list.
- [x] Approve an external recorder pilot.

## Before production data

- [x] Create protected household access and API after approval.
- [ ] Verify parcel data rights and coverage.
- [x] Define CSV identity, provenance, dry-run, and no-overwrite contract.
- [x] Add synthetic CSV import-plan validation and privacy regression tests.
- [x] Run a dry import with synthetic data only.
- [x] Support CSV and XLSX synthetic dry-run planning with identical identity safeguards.
- [x] Implement resumable synthetic import-plan staging without provider values.
- [ ] Implement protected, resumable CSV/XLSX import application after approval.

## Before release

- [x] Measure coverage against a deduplicated road network and atomically replace all pipeline artifacts.
- [x] Share canonical road intervals between coverage and undriven output.
- [x] Add geometric fixture tests for partial, duplicate, divided, and boundary roads.
- [ ] Complete the recorder pilot (Traccar one-phone setup, locked-screen drive, retry, and Stop verification).
- [x] Provision and deploy the approved authenticated private API and phone-side offline queue.
- [ ] Complete two-device field usability testing.
- [x] Approve external hosting and deployment.
- [ ] Import real property data only after review.
