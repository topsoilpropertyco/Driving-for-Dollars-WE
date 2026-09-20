# Private household store contract

`household_store.py` is the local, executable persistence layer for the
household action contract. It uses a SQLite transaction and an event-ID primary
key to guarantee that a retried offline action cannot duplicate a saved
property, note, stage change, or outreach record.

The database is private local state (`data/private/household.sqlite3`, already
ignored by Git). It is not initialized by the prototype or CI, and this project
does not currently run an HTTP service or host it anywhere.

## Guarantees

- Entire action batches validate before any database write.
- A batch either commits completely or leaves no actions behind.
- The database retains append-only history; a newer stage updates the display
  summary but does not erase older notes or decisions.
- Source imports cannot call this store to alter household-owned actions.
- The future protected API must authenticate a household device before calling
  `ingest_actions`, scope all reads to that household, and keep the database
  and backups out of the public repository, Pages artifact, CI cache, and logs.

## Approval boundary

The next step is wrapping this store in an authenticated private API and
choosing its host. That requires explicit approval because it creates a new
external service that will hold private property/owner and location-adjacent
data.
