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
- [ ] Approve an external recorder pilot.

## Before production data

- [ ] Create protected household access and API after approval.
- [ ] Verify parcel data rights and coverage.
- [x] Define CSV identity, provenance, dry-run, and no-overwrite contract.
- [x] Add synthetic CSV import-plan validation and privacy regression tests.
- [x] Run a dry import with synthetic data only.
- [ ] Implement protected, resumable CSV/XLSX import application after approval.

## Before release

- [x] Measure coverage against a deduplicated road network and atomically replace all pipeline artifacts.
- [x] Share canonical road intervals between coverage and undriven output.
- [x] Add geometric fixture tests for partial, duplicate, divided, and boundary roads.
- [ ] Complete the recorder pilot.
- [ ] Implement household CRM and offline queue.
- [ ] Complete two-device field usability testing.
- [ ] Approve external hosting and deployment.
- [ ] Import real property data only after review.
