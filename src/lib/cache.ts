import type { RemoteRecord } from '../../shared/protocol';

async function db() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('CloudVault', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('encrypted');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function cachedJournal(account: string): Promise<RemoteRecord[]> {
  const database = await db();
  try {
    return await new Promise((resolve, reject) => {
      const req = database.transaction('encrypted').objectStore('encrypted').get(account);
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
  } finally { database.close(); }
}

async function write(account: string, records?: RemoteRecord[]) {
  const database = await db();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('encrypted', 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      const store = tx.objectStore('encrypted');
      if (records) store.put(records, account);
      else store.delete(account);
    });
  } finally { database.close(); }
}

export const cacheJournal = (account: string, records: RemoteRecord[]) => write(account, records);
export const clearCache = (account: string) => write(account);
