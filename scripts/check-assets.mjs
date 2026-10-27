import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { log } from 'node:console';
import { labCampaign } from '../packages/contracts/dist/index.js';

for (const asset of labCampaign.assets) {
  if (!/^\/assets\/(?!.*\.\.)[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(asset.url)) {
    throw new Error(`Unsafe asset path: ${asset.id}`);
  }
  const file = new URL(`../apps/web/public${asset.url}`, import.meta.url);
  const content = await readFile(file);
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
  if (content.length !== asset.bytes || !asset.url.includes(`.${hash}.`)) {
    throw new Error(`Asset size or filename hash does not match the release manifest: ${asset.id}`);
  }
}
log(`Verified ${labCampaign.assets.length} versioned asset(s): exact sizes and SHA-256 filenames.`);
