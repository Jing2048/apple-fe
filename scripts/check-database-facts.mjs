import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { deepStrictEqual, strictEqual } from 'node:assert';
import { log } from 'node:console';

const smoke = JSON.parse(await readFile('.artifacts/container-smoke.json', 'utf8'));
const id = smoke.receipt?.participationId;
if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
  throw new Error('Run the current container smoke before checking database facts.');
const query = `
  SELECT jsonb_build_object(
    'participationId', p.participation_id,
    'campaignId', p.campaign_id,
    'roundId', p.idempotency_key,
    'receiptRows', (SELECT count(*) FROM participations p2
      WHERE p2.session_id=p.session_id AND p2.campaign_id=p.campaign_id AND p2.idempotency_key=p.idempotency_key),
    'sessionTotal', (SELECT count(*) FROM analytics_events e WHERE e.owner_session_id=p.session_id),
    'roundTotal', (SELECT count(*) FROM analytics_events e WHERE e.owner_session_id=p.session_id
      AND e.payload->>'campaignId'=p.campaign_id
      AND lower(e.payload->'properties'->>'roundId')=p.idempotency_key::text),
    'byName', COALESCE((SELECT jsonb_agg(jsonb_build_object('eventName', event_name, 'count', count) ORDER BY event_name)
      FROM (SELECT e.payload->>'eventName' AS event_name, count(*)::int AS count
        FROM analytics_events e WHERE e.owner_session_id=p.session_id
        AND e.payload->>'campaignId'=p.campaign_id
        AND lower(e.payload->'properties'->>'roundId')=p.idempotency_key::text
        GROUP BY e.payload->>'eventName') grouped), '[]'::jsonb),
    'migrations', (SELECT jsonb_agg(name ORDER BY name) FROM schema_migrations)
  ) FROM participations p WHERE p.participation_id='${id}'::uuid
`;
const result = spawnSync(
  'docker',
  ['exec', 'apple-lab-db-1', 'psql', '-U', 'apple', '-d', 'apple_lab', '-Atc', query],
  { encoding: 'utf8' },
);
if (result.status !== 0) throw new Error('The local lab database check could not execute.');
const facts = JSON.parse(result.stdout);
strictEqual(facts.participationId, id);
strictEqual(facts.campaignId, smoke.receipt.campaignId);
strictEqual(facts.roundId, smoke.database.roundId);
strictEqual(facts.receiptRows, 1);
strictEqual(facts.sessionTotal, smoke.database.eventSummary.sessionTotal);
strictEqual(facts.roundTotal, smoke.database.eventSummary.roundTotal);
deepStrictEqual(facts.byName, smoke.database.eventSummary.byName);
deepStrictEqual(facts.migrations, ['001_initial', '002_event_ownership', '003_campaign_catalog']);
await writeFile(
  '.artifacts/persisted-flow-check.json',
  JSON.stringify({ checkedAt: new Date().toISOString(), facts }, null, 2) + '\n',
);
log(
  `Verified directly in PostgreSQL: one receipt, ${facts.roundTotal} round events, and all three migrations. No session identities or raw events were exported.`,
);
