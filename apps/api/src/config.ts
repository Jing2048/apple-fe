import { randomBytes } from 'node:crypto';

export interface ApiConfig {
  databaseUrl: string;
  host: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  appOrigin: string;
  releaseId: string;
  providerMode: 'mock';
  sessionSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  const providerMode = env.PROVIDER_MODE ?? 'mock';
  if (providerMode !== 'mock') {
    throw new Error(
      'No real provider adapter is configured. PROVIDER_MODE must be mock in development.',
    );
  }
  if (nodeEnv === 'production') {
    throw new Error('Production startup is blocked: the external provider is still a mock.');
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid Postgres URL');
  }
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) {
    throw new Error('DATABASE_URL must use postgres or postgresql');
  }
  let origin: URL;
  try {
    origin = new URL(env.APP_ORIGIN ?? 'http://localhost:5173');
  } catch {
    throw new Error('APP_ORIGIN must be a valid HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.origin !== origin.href.replace(/\/$/, '')
  ) {
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path');
  }
  const port = Number(env.PORT ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  const releaseId = env.RELEASE_ID ?? 'local';
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(releaseId))
    throw new Error('RELEASE_ID has invalid characters');
  const sessionSecret = env.SESSION_SECRET ?? randomBytes(32).toString('hex');
  if (sessionSecret.length < 32)
    throw new Error('SESSION_SECRET must contain at least 32 characters');
  return {
    databaseUrl,
    host: env.HOST ?? '127.0.0.1',
    port,
    nodeEnv: nodeEnv as ApiConfig['nodeEnv'],
    appOrigin: origin.origin,
    releaseId,
    providerMode: 'mock',
    sessionSecret,
  };
}
