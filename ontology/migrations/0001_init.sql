-- Migration number: 0001
-- Runtime write stores only: the read path (entities/aliases/trigrams) lives
-- in the bundled index, not the database.

CREATE TABLE resolution_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  status TEXT NOT NULL,          -- resolved | ambiguous | low_confidence | miss
  gid TEXT,
  confidence REAL,
  context TEXT,                  -- JSON of the request context
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_resolution_log_status ON resolution_log (status, created_at);
CREATE INDEX idx_resolution_log_key ON resolution_log (raw_key);

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_key TEXT NOT NULL,
  wrong_gid TEXT,                -- what we resolved to (NULL if miss)
  correct_gid TEXT NOT NULL,     -- what the user says it should be
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  curated_at TEXT                -- set when folded into data/aliases/*.json
);
CREATE INDEX idx_feedback_uncurated ON feedback (curated_at, created_at);
