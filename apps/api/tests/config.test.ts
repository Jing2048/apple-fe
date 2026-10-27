import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://unused:unused@localhost/test', NODE_ENV: 'test' };

describe('runtime configuration guards', () => {
  it('requires a database instead of silently switching to memory', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow('DATABASE_URL is required');
  });
  it('does not include malformed credential strings in configuration errors', () => {
    const secret = 'sensitive-password-do-not-log';
    try {
      loadConfig({ ...base, DATABASE_URL: secret });
      throw new Error('Expected a configuration error');
    } catch (error) {
      expect(String(error)).toContain('DATABASE_URL');
      expect(String(error)).not.toContain(secret);
    }
  });
  it('fails closed when production would use mock business integration', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      'Production startup is blocked',
    );
  });
  it('does not pretend an unsupported provider is configured', () => {
    expect(() => loadConfig({ ...base, PROVIDER_MODE: 'apple' })).toThrow(
      'No real provider adapter',
    );
  });
  it('validates the declared runtime environment', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'prod' })).toThrow('NODE_ENV');
  });
  it.each(['file:/tmp/db', 'https://example.com'])('rejects a non-Postgres URL %s', (url) => {
    expect(() => loadConfig({ ...base, DATABASE_URL: url })).toThrow('postgres');
  });
  it.each(['https://example.com/path', 'ftp://example.com', 'https://example.com?query=1'])(
    'rejects a non-origin APP_ORIGIN %s',
    (origin) => {
      expect(() => loadConfig({ ...base, APP_ORIGIN: origin })).toThrow('APP_ORIGIN');
    },
  );
  it.each(['0', '65536', '1.5', 'not-a-port'])('rejects invalid port %s', (port) => {
    expect(() => loadConfig({ ...base, PORT: port })).toThrow('PORT');
  });
  it('rejects secrets too short for session signing', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow('SESSION_SECRET');
  });
  it('normalizes a trailing slash without allowing URL credentials', () => {
    expect(loadConfig({ ...base, APP_ORIGIN: 'https://example.com/' }).appOrigin).toBe(
      'https://example.com',
    );
    expect(() => loadConfig({ ...base, APP_ORIGIN: 'https://user:password@example.com' })).toThrow(
      'APP_ORIGIN',
    );
  });
});
