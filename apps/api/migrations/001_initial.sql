CREATE TABLE IF NOT EXISTS analytics_events (
  event_id uuid PRIMARY KEY,
  payload jsonb NOT NULL,
  fingerprint text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analytics_events_received_at_idx ON analytics_events (received_at);

CREATE TABLE IF NOT EXISTS participations (
  participation_id uuid PRIMARY KEY,
  session_id uuid NOT NULL,
  campaign_id text NOT NULL CHECK (campaign_id = 'lab'),
  interaction text NOT NULL CHECK (interaction IN ('timing', 'swipe')),
  idempotency_key uuid NOT NULL,
  provider_mode text NOT NULL CHECK (provider_mode = 'mock'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, campaign_id, idempotency_key)
);

COMMENT ON TABLE participations IS 'Development participation receipts only. No prizes or membership integration.';
