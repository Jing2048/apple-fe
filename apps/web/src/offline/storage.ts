import { postRecoveryKey, type PostStorage } from '../post/recovery';

export const offlineStoragePrefix = 'cloud-post.offline.v1.';
export const offlineRecordsKey = `${offlineStoragePrefix}records`;
export const offlineDraftKey = `${offlineStoragePrefix}draft`;
export const offlineProbeKey = `${offlineStoragePrefix}probe`;

export type OfflineNamespace = 'classic' | 'new-year';
const classicKeys = Object.freeze({
  records: offlineRecordsKey,
  draft: offlineDraftKey,
  probe: offlineProbeKey,
});
const newYearKeys = Object.freeze({
  records: 'cloud-post.offline.new-year.v1.records',
  draft: 'cloud-post.offline.new-year.v1.draft',
  probe: 'cloud-post.offline.new-year.v1.probe',
});

export function getOfflineStorageKeys(
  namespace: OfflineNamespace = 'classic',
): Readonly<{ records: string; draft: string; probe: string }> {
  if (namespace === 'classic') return classicKeys;
  if (namespace === 'new-year') return newYearKeys;
  throw new Error('Unsupported offline namespace.');
}

function boundStorage(storage: PostStorage): PostStorage {
  return {
    getItem: storage.getItem.bind(storage),
    setItem: storage.setItem.bind(storage),
    removeItem: storage.removeItem.bind(storage),
  };
}

/** Web Storage may be denied, including for file: URLs. No persistence is assumed. */
export function getOfflineLocalStorage(): PostStorage | null {
  try {
    return typeof window === 'undefined' ? null : boundStorage(window.localStorage);
  } catch {
    return null;
  }
}

/** Adapts existing recovery helpers without ever touching the online draft key. */
export function getOfflineDraftStorage(
  storage?: PostStorage | null,
  namespace: OfflineNamespace = 'classic',
): PostStorage | null {
  const keys = getOfflineStorageKeys(namespace);
  const source = storage === undefined ? getOfflineLocalStorage() : storage;
  if (!source) return null;
  try {
    const target = boundStorage(source);
    const requireDraftKey = (key: string) => {
      if (key !== postRecoveryKey) throw new Error('Unsupported offline draft key.');
    };
    return {
      getItem(key) {
        requireDraftKey(key);
        return target.getItem(keys.draft);
      },
      setItem(key, value) {
        requireDraftKey(key);
        target.setItem(keys.draft, value);
      },
      removeItem(key) {
        requireDraftKey(key);
        target.removeItem(keys.draft);
      },
    };
  } catch {
    return null;
  }
}
