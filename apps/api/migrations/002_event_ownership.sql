ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS owner_session_id uuid;

CREATE INDEX IF NOT EXISTS analytics_events_owner_session_idx
  ON analytics_events (owner_session_id);

CREATE INDEX IF NOT EXISTS analytics_events_owner_round_idx
  ON analytics_events (owner_session_id, (lower((payload->'properties')->>'roundId')));

COMMENT ON COLUMN analytics_events.owner_session_id IS
  'Verified signed-cookie session at ingestion. NULL for legacy events; never inferred from client payload.';
