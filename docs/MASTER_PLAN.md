# Grosse Pointe Home Search App

## Product contract

This is a shared, iPhone-first home-search app for Seth and Claire. It helps
them explore every public street in the five Grosse Pointes, save promising
properties while driving, and manage a deliberately small research pipeline.

The cities always appear in this order:

1. Grosse Pointe Park
2. Grosse Pointe
3. Grosse Pointe Farms
4. Grosse Pointe Shores
5. Grosse Pointe Woods

Park, Farms, and Woods are current priority cities. A street is explored once
when it has been driven in either direction. Private roads, alleys, driveways,
and parking lots are excluded.

## Household experience

- **Explore:** map, street coverage, start-area suggestions, recording state,
  and a fast property sheet.
- **Properties:** saved properties, notes, sources, and next actions.
- **Funnel:** a current-stage view and an honest progress view. Estimated
  properties passed never masquerade as saved or contacted properties.
- **Data:** imports, source coverage, matching questions, exports, and health.

The passenger flow is: tap property, tap Save, optionally write a note, and
continue. The interface must be touch-first, fast, calm, and readable in a car
when used by a passenger or while parked.

## Data and privacy boundary

Public geographic data may include streets, boundaries, and a deliberately
sanitized combined coverage view. Private data includes GPS recordings,
recording metadata, owner/contact information, provider rows, notes, stages,
and source history. Private data is never committed, cached in CI, placed in a
public build, or logged.

The production app will use a shared household access mechanism with revocable
device sessions; it does not require separate daily logins. It must not be
implemented or deployed until the owner approves external service setup.

Existing Do Not Call columns are source data only. This project provides no
filtering, warnings, restrictions, or automation based on them.

## Recording requirement

Normal operation is **Start -> drive -> Stop -> automatic secure delivery ->
coverage processing**. Manual GPX upload is recovery-only. The web app must not
claim to be a reliable locked-screen iPhone recorder. A native recording
companion must be selected and tested before production integration.

Live recording can show a provisional trail. Confirmed street color changes may
finish after stopping, provided the status is clear.

## Geographic model

Coverage is based on canonical public-road intervals, not whole street features
or a simple any-touch rule. A shared regional network is clipped to the five
city boundaries, deduplicated, and attributed back to cities. Track candidates
are constrained by distance, direction, and continuity. Only accepted interval
length contributes to coverage. The same evidence drives both the statistics and
the remaining-street map.

Property identity is jurisdiction-qualified APN first, then known aliases, then
careful address/unit matching. Provider observations retain their source and
date. Imports never overwrite notes, stages, or outreach history.

## Release gates

Before real data or deployment:

1. Synthetic-data privacy, import, geographic, and mobile tests pass.
2. A two-phone recording pilot proves Start/Stop, locked-screen recording,
   automatic delivery, retry behavior, and reliable Stop behavior.
3. Parcel-source coverage, licensing, and APN matching are verified.
4. Household access, hosting, deployment, and production import are explicitly
   approved.
5. A field usability review approves the actual phone experience.

## Current delivery order

1. Safety contracts, durable checklist, and synthetic UX prototype.
2. Recording feasibility adapter contract and device pilot plan.
3. Protected household API and property/import foundation after approval.
4. Canonical roads, parcel matching, and evidence-based coverage.
5. Shared CRM, offline queue, automation, and deployment.

No external services, deployment, production imports, or private GPS access are
authorized in the current phase.
