import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { readReleaseId } from '../build-metadata';

const directory = mkdtempSync(join(tmpdir(), 'campaign-build-test-'));
const file = join(directory, '.env');
afterEach(() => rmSync(file, { force: true }));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('public build metadata isolation', () => {
  it('does not let a development .env change production build mode', () => {
    const previous = process.env.NODE_ENV;
    writeFileSync(
      file,
      'NODE_ENV=development\nRELEASE_ID=fixture-v1\nPRIVATE_VALUE=never-bundle\n',
    );
    expect(readReleaseId({}, file)).toBe('fixture-v1');
    expect(process.env.NODE_ENV).toBe(previous);
    expect(process.env.PRIVATE_VALUE).toBeUndefined();
  });
  it('prefers the explicit release and falls back safely without a file', () => {
    expect(readReleaseId({ RELEASE_ID: 'ci-v2' }, file)).toBe('ci-v2');
    expect(readReleaseId({}, file)).toBe('local-dev');
  });
  it('rejects invalid release labels without echoing their contents', () => {
    expect(() => readReleaseId({ RELEASE_ID: 'invalid label' }, file)).toThrow(
      'Invalid public release identifier',
    );
  });
});
