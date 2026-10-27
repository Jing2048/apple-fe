import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** Read one public build value without mutating NODE_ENV or exposing other variables. */
export function readReleaseId(env: NodeJS.ProcessEnv, envFile: string): string {
  const local = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const releaseId = env.RELEASE_ID ?? local.RELEASE_ID ?? 'local-dev';
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(releaseId))
    throw new Error('Invalid public release identifier');
  return releaseId;
}
