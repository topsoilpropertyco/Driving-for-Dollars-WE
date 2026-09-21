# Private Cloudflare deployment package

This is the deployable production API package. It is intentionally inert in
Git: no account ID, D1 ID, bucket name, email address, API token, or secret is
committed.

## Intended topology

`one private app URL -> Cloudflare Access -> Worker -> D1 / R2`

- Cloudflare Access is configured with one-time email PIN login and an allow
  policy containing only Seth's and Claire's email addresses.
- Access protects the entire private Worker route. The Worker additionally
  checks the Access identity against `ALLOWED_EMAILS`, stored as a Worker secret.
- D1 stores household actions and future private import metadata.
- R2 stores private raw GPS/session files. It has no public bucket endpoint.
- The public GitHub Pages prototype remains separate and never calls this API.
- `private_app/` is the same-origin iPhone shell served by the private Worker,
  never by GitHub Pages. It queues household actions on the phone while offline
  and removes only server-confirmed action IDs after a sync.

## Provisioning status

The D1 database, private R2 bucket, and Worker shell are provisioned. The
deployment is still fail-closed: Cloudflare Access and the `ALLOWED_EMAILS`
Worker secret must be configured before the private app can load for anyone.
Resource identifiers remain only in ignored local deployment configuration,
never in Git.

Any future access-policy, storage-retention, or production-data change still
requires the owner's explicit approval.

## First production acceptance checks

1. An unapproved email receives HTTP 401 and cannot enumerate data.
2. Seth and Claire can receive an Access one-time PIN and use the same private URL.
3. A synthetic action batch persists once; resubmission is idempotent.
4. Browser data cannot be read from a public origin or GitHub Pages.
5. No D1/R2 endpoint is public, and no secret appears in source, logs, or CI.
6. Only after all five pass may a reviewed real property import dry-run begin.

## Import-plan API boundary

The Worker has a private `POST /api/v1/import-plans` endpoint for a sanitized
dry-run plan, `GET /api/v1/import-plans/{id}` for reconnect-safe aggregate
progress, and `POST /api/v1/import-plans/{id}/advance` for bounded review
staging. The request may include normalized parcel/address identities, row
numbers, field *names*, and aggregate rejection counts. It deliberately cannot
accept raw spreadsheet rows, owner names, phone numbers, emails, or other
provider values. A separate reviewed importer is required before any of those
values may enter D1 or R2.
