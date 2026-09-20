CREATE TABLE IF NOT EXISTS import_plan_records (
  import_id TEXT NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  identity_kind TEXT NOT NULL CHECK (identity_kind IN ('apn', 'address_candidate')),
  identity_key TEXT NOT NULL,
  review_required INTEGER NOT NULL CHECK (review_required IN (0, 1)),
  source_fields_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'validated', 'review_required')),
  PRIMARY KEY (import_id, row_number),
  FOREIGN KEY (import_id) REFERENCES import_runs(import_id)
);

CREATE INDEX IF NOT EXISTS import_plan_records_by_run_status
  ON import_plan_records (import_id, status, row_number);
