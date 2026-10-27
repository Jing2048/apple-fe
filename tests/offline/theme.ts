import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Acceptance copy is explicit so a wrong production theme/index mapping fails.
export const offlineThemes = {
  classic: {
    id: 'classic',
    filename: 'cloud-post-offline.html',
    relocatedFilename: '云朵邮局 单文件演示.html',
    brand: '云朵邮局',
    prefix: 'cloud-post.offline.v1.',
    blessingNames: ['寄给慢慢来的你', '寄给值得好运的你', '寄给认真生活的你'],
    blessingTitles: [
      '愿你慢慢来，也会闪闪发光。',
      '愿小小的好运，恰好落在你身边。',
      '愿你被生活温柔以待。',
    ],
  },
  'new-year': {
    id: 'new-year',
    filename: 'cloud-post-new-year.html',
    relocatedFilename: '云朵邮局 新年单文件演示.html',
    brand: '新春云朵邮局',
    prefix: 'cloud-post.offline.new-year.v1.',
    blessingNames: ['寄给新一年的你', '寄给想团圆的你', '寄给许心愿的你'],
    blessingTitles: [
      '愿新的一年，常有新意，也常有欢喜。',
      '愿想念都有回音，团圆就在身边。',
      '愿心里的小愿望，慢慢长成好光景。',
    ],
  },
} as const;

export type OfflineThemeId = keyof typeof offlineThemes;
const selected = process.env.OFFLINE_THEME ?? 'classic';
if (selected !== 'classic' && selected !== 'new-year')
  throw new Error('OFFLINE_THEME must be classic or new-year.');
export const offlineTheme = offlineThemes[selected];
export const offlineAuxiliaryBase = process.env.OFFLINE_TEST_BASE_URL;
if (offlineAuxiliaryBase) {
  const url = new URL(offlineAuxiliaryBase);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('HTTP auxiliary acceptance requires an explicit loopback HTTP origin.');
}
export const offlineArtifactPath = resolve(`.artifacts/offline/${offlineTheme.filename}`);
export function offlineArtifactUrlFor(id: OfflineThemeId): string {
  const filename = offlineThemes[id].filename;
  return offlineAuxiliaryBase
    ? new URL(filename, `${offlineAuxiliaryBase.replace(/\/$/, '')}/`).href
    : pathToFileURL(resolve(`.artifacts/offline/${filename}`)).href;
}
export const offlineArtifactUrl = offlineArtifactUrlFor(offlineTheme.id);
const basePrefix = offlineAuxiliaryBase ? 'offline-http' : 'offline';
export const offlineReportPrefix =
  offlineTheme.id === 'classic' ? basePrefix : `${basePrefix}-${offlineTheme.id}`;
export const offlineScreenshotDirectory =
  offlineTheme.id === 'classic'
    ? `.artifacts/${basePrefix}`
    : `.artifacts/${basePrefix}/${offlineTheme.id}`;
