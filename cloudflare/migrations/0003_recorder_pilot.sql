-- Private recorder identities and points. Raw location stays in the private D1
-- database and is never copied to the public dashboard or Git repository.
CREATE TABLE IF NOT EXISTS recorder_devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_by_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS recorder_points (
  device_id TEXT NOT NULL REFERENCES recorder_devices(device_id),
  recorded_at TEXT NOT NULL,
  latitude REAL NOT NULL CHECK (latitude >= -90 AND latitude <= 90),
  longitude REAL NOT NULL CHECK (longitude >= -180 AND longitude <= 180),
  accuracy_meters REAL,
  speed_mps REAL,
  bearing_degrees REAL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, recorded_at, latitude, longitude)
);

CREATE INDEX IF NOT EXISTS recorder_points_by_device_time
  ON recorder_points (device_id, recorded_at);
