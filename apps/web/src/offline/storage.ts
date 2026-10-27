import { postRecoveryKey, type PostStorage } from '../post/recovery';

export const offlineStoragePrefix = 'cloud-post.offline.v1.';
export const offlineRecordsKey = `${offlineStoragePrefix}records`;
export const offlineDraftKey = `${offlineStoragePrefix}draft`;
export const offlineProbeKey = `${offlineStoragePrefix}probe`;

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
  storage: PostStorage | null = getOfflineLocalStorage(),
): PostStorage | null {
  if (!storage) return null;
  try {
    const target = boundStorage(storage);
    const requireDraftKey = (key: string) => {
      if (key !== postRecoveryKey) throw new Error('Unsupported offline draft key.');
    };
    return {
      getItem(key) {
        requireDraftKey(key);
        return target.getItem(offlineDraftKey);
      },
      setItem(key, value) {
        requireDraftKey(key);
        target.setItem(offlineDraftKey, value);
      },
      removeItem(key) {
        requireDraftKey(key);
        target.removeItem(offlineDraftKey);
      },
    };
  } catch {
    return null;
  }
}
