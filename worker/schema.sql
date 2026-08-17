-- Private view log for the trip site. Nothing here is ever shown in the page.
--
-- Two tables on purpose: `visits` is the append-only record, `devices` is the
-- one row per browser that carries the label you assign it. Keeping the label
-- out of `visits` means renaming someone does not mean rewriting history.

CREATE TABLE IF NOT EXISTS visits (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT    NOT NULL,          -- ISO8601 UTC
  device  TEXT    NOT NULL,          -- random id from the visitor's localStorage
  ip      TEXT,
  city    TEXT,
  region  TEXT,
  country TEXT,
  asn     INTEGER,
  isp     TEXT,                      -- request.cf.asOrganization, e.g. "Charter"
  ua      TEXT,
  ref     TEXT
);

CREATE INDEX IF NOT EXISTS visits_at_idx     ON visits (at DESC);
CREATE INDEX IF NOT EXISTS visits_device_idx ON visits (device, at DESC);

CREATE TABLE IF NOT EXISTS devices (
  device     TEXT PRIMARY KEY,
  label      TEXT,                   -- you fill this in from the dashboard
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS devices_last_seen_idx ON devices (last_seen DESC);
