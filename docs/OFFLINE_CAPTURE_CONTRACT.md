# Offline household capture contract

## Goal

The passenger flow must work when cellular service is weak: tap a property,
save it, optionally add a note or stage, and keep driving. The phone records a
local action first, shows it as queued, and reconciles it once authenticated
service is reachable. A user never needs to resubmit an action because a
request timed out.

## Action envelope

Each action has a UUID event ID, opaque device ID, per-device sequence,
UTC timestamp, property identity, action kind, and minimal action payload.
Supported kinds are property saved, note added, stage changed, and outreach
logged. The validated stage vocabulary is:

`no_outreach`, `reached_out`, `waiting_for_reply`, `in_conversation`,
`contractor_offer`, `realtor_referral`, `closed`, and `archived`.

The UI may use friendlier labels, but the stored values stay stable.

## Reconciliation rules

- Local actions are written to device storage before a network attempt.
- The API uses event ID as its idempotency key and stores a uniqueness
  constraint. A repeated submission returns success without duplicating a note
  or outreach event.
- Sequence is meaningful only within a device. Seth's and Claire's phones may
  act while offline simultaneously; neither is blocked by the other.
- Imports are provider observations only. They can never write these actions,
  change a household stage, or overwrite a household note.
- Conflicting stage changes are retained as a timestamped household history;
  the UI identifies the current result and exposes the history rather than
  silently erasing a partner's action.

## Current boundary

`household_actions.py` validates synthetic action envelopes and retry behavior.
There is no device storage, API endpoint, login, production action, or private
data connection yet. Building those requires the approved protected household
service.
