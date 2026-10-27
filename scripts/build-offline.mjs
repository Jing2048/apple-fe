import { createRequire } from 'node:module';
import { Buffer } from 'node:buffer';
import { log } from 'node:console';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';

// Resolve the existing web toolchain; no extra bundler or single-file plugin dependency.
const webRoot = fileURLToPath(new URL('../apps/web/', import.meta.url));
const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { build } = await import(requireWeb.resolve('vite'));
const { default: react } = await import(requireWeb.resolve('@vitejs/plugin-react'));
const result = await build({
  configFile: false,
  root: webRoot,
  publicDir: false,
  base: './',
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.VITE_RELEASE_ID': JSON.stringify('offline-v1'),
  },
  build: {
    write: false,
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: false,
    minify: true,
    lib: {
      entry: fileURLToPath(new URL('../apps/web/src/offline/main.tsx', import.meta.url)),
      formats: ['iife'],
      name: 'CloudPostOffline',
    },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output);
const scripts = outputs.filter((output) => output.type === 'chunk');
const styles = outputs.filter(
  (output) => output.type === 'asset' && output.fileName.endsWith('.css'),
);
const otherAssets = outputs.filter(
  (output) => output.type === 'asset' && !output.fileName.endsWith('.css'),
);
if (
  scripts.length !== 1 ||
  scripts.some((script) => script.imports.length || script.dynamicImports.length) ||
  otherAssets.length
)
  throw new Error(
    'Offline build must contain one self-contained script, CSS, and no external assets.',
  );
const javascript = scripts[0].code.replace(/<\/script/gi, '<\\/script');
const css = styles
  .map((style) =>
    typeof style.source === 'string' ? style.source : new TextDecoder().decode(style.source),
  )
  .join('\n');
if (
  /<\/style/i.test(css) ||
  /@import\b/i.test(css) ||
  /url\(\s*["']?(?!data:|#)[^\s"')]/i.test(css)
)
  throw new Error(
    'Offline CSS must not contain external imports, resources, or closing style tags.',
  );
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f8f6ef">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; font-src 'none'; media-src blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="description" content="云朵邮局单文件离线演示；记录仅在本机，不连接服务端。">
<title>云朵邮局 · 离线演示</title><style>${css}</style></head>
<body><noscript>这是离线演示，请用支持 JavaScript 的现代浏览器打开完整 HTML 文件。</noscript><div id="root"></div><script>${javascript}</script></body></html>\n`;
const bytes = Buffer.byteLength(html);
if (bytes > 512 * 1024) throw new Error(`Offline file exceeds the 512 KiB budget: ${bytes} bytes.`);
const output = new URL('../.artifacts/offline/cloud-post-offline.html', import.meta.url);
await mkdir(new URL('./', output), { recursive: true });
await writeFile(output, html);
const report = {
  file: fileURLToPath(output),
  bytes,
  sha256: createHash('sha256').update(html).digest('hex'),
  javascriptBytes: Buffer.byteLength(javascript),
  cssBytes: Buffer.byteLength(css),
  files: 1,
  externalAssets: 0,
};
await writeFile(new URL('./build.json', output), JSON.stringify(report, null, 2) + '\n');
log(JSON.stringify(report, null, 2));
