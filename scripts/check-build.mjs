import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { log } from 'node:console';

const root = resolve('apps/web/dist');
const files = await readdir(root, { recursive: true });
const chunks = [];
for (const file of files.filter((name) => /\.(js|css)$/.test(name))) {
  const content = await readFile(resolve(root, file));
  chunks.push({
    file: relative(root, resolve(root, file)),
    bytes: content.length,
    gzipBytes: gzipSync(content).length,
  });
}
const index = await readFile(resolve(root, 'index.html'), 'utf8');
if (/<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i.test(index)) {
  throw new Error('The entry page depends on an external script or stylesheet.');
}
const jsGzipBytes = chunks
  .filter((chunk) => chunk.file.endsWith('.js'))
  .reduce((sum, chunk) => sum + chunk.gzipBytes, 0);
const cssGzipBytes = chunks
  .filter((chunk) => chunk.file.endsWith('.css'))
  .reduce((sum, chunk) => sum + chunk.gzipBytes, 0);
const report = {
  measuredAt: new Date().toISOString(),
  kind: 'build-size-baseline',
  jsGzipBytes,
  cssGzipBytes,
  budgets: { jsGzipBytes: 200 * 1024, cssGzipBytes: 30 * 1024 },
  chunks,
};
await mkdir('.artifacts', { recursive: true });
await writeFile('.artifacts/build-budget.json', JSON.stringify(report, null, 2) + '\n');
log(
  `All JS gzip: ${jsGzipBytes} bytes / ${report.budgets.jsGzipBytes}; CSS gzip: ${cssGzipBytes} bytes / ${report.budgets.cssGzipBytes}`,
);
if (jsGzipBytes > report.budgets.jsGzipBytes || cssGzipBytes > report.budgets.cssGzipBytes) {
  throw new Error(
    'Build exceeds the initial lab transfer budget. Inspect .artifacts/build-budget.json.',
  );
}
