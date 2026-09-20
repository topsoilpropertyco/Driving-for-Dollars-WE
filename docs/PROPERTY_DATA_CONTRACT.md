# Property data and import contract

## Current implementation boundary

`property_import.py` is a **synthetic-only, no-write validation layer**. It
reads a CSV, produces an in-memory import plan, and prints aggregate results.
It does not upload, persist, log, or commit a property, owner, phone, email,
or address value. It is safe to exercise only with the committed synthetic
fixture during this phase.

The future protected service, not this public repository or Pages site, will
store private property and owner data.

## Identity and merge rules

1. The primary identity is `state + county + APN`, normalized without spaces or
   punctuation. APNs remain strings; they are never treated as numbers.
2. A row lacking any part of that identity may form an `address_candidate` only
   when state, city, and address are present. It always requires review and is
   never automatically merged.
3. Duplicate identities within one file are rejected for review. A repeat file
   cannot silently duplicate observations.
4. Provider observations retain provider label, import time, and source fields.
   Household notes, CRM stage, outreach history, and manual corrections are
   household-owned records and cannot be overwritten by an import.

## Import lifecycle after approval

1. Upload to private, encrypted storage over authenticated household access.
2. Read the header and construct a dry-run plan; show only counts, columns,
   unresolved candidates, and validation reasons in routine UI.
3. Require the user to confirm an import version before applying it.
4. Write observations and import audit state in one transaction.
5. Make the resulting source coverage and unmatched queue available in Data.
6. Preserve the original private input only under the agreed retention policy;
   never commit it, put it in CI artifacts, or expose it through the public app.

## Supported CSV headers

Canonical fields accept common aliases: APN/parcel number, address/property
address, unit, city, state, zip, and county. Unknown columns are preserved as
provider fields by the future private importer but are not used to identify a
property. CSV is the first supported format. XLSX parsing is deferred until the
protected service and review flow exist; it must use the same import plan and
must not bypass validation.

## Operational safeguards

- Diagnostics use row numbers and field names, never values.
- Import fingerprints describe the provider, header shape, and row count, not
  row contents; they support review and idempotency without leaking data.
- Invalid rows do not block valid rows in a dry run, but a production apply
  must be explicitly reviewed if any rejections or address candidates exist.
- Exports will be an explicit protected action with a user-selected scope; no
  automatic CSV export is part of the public dashboard.
