-- Worker/D1 schema. Separate from the PostgreSQL migration history.
CREATE TABLE IF NOT EXISTS analytics_events (
  event_id TEXT PRIMARY KEY NOT NULL CHECK (event_id = lower(event_id)),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  fingerprint TEXT NOT NULL,
  owner_session_id TEXT CHECK (owner_session_id IS NULL OR owner_session_id = lower(owner_session_id)),
  delivery_count INTEGER NOT NULL DEFAULT 1 CHECK (delivery_count >= 1),
  conflict_guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT event_identity_guard CHECK (conflict_guard = 1),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS analytics_events_owner_session_idx
  ON analytics_events (owner_session_id);
CREATE INDEX IF NOT EXISTS analytics_events_owner_round_idx
  ON analytics_events (owner_session_id, lower(json_extract(payload, '$.properties.roundId')));

CREATE TABLE IF NOT EXISTS participations (
  participation_id TEXT PRIMARY KEY NOT NULL CHECK (participation_id = lower(participation_id)),
  session_id TEXT NOT NULL CHECK (session_id = lower(session_id)),
  campaign_id TEXT NOT NULL CHECK (
    length(campaign_id) BETWEEN 1 AND 64
    AND campaign_id NOT GLOB '*[^a-z0-9-]*'
    AND substr(campaign_id, 1, 1) <> '-'
    AND substr(campaign_id, -1) <> '-'
    AND instr(campaign_id, '--') = 0
  ),
  interaction TEXT NOT NULL CHECK (interaction IN ('timing', 'swipe')),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key = lower(idempotency_key)),
  provider_mode TEXT NOT NULL CHECK (provider_mode = 'mock'),
  created_at TEXT NOT NULL,
  conflict_guard INTEGER NOT NULL DEFAULT 1 CONSTRAINT participation_idempotency_guard CHECK (conflict_guard = 1),
  UNIQUE (session_id, campaign_id, idempotency_key)
);
