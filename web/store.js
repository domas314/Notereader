// Saved scores live in the phone's own storage (IndexedDB), so they keep
// working offline and nothing needs to be scanned twice.

const DB_NAME = 'notereader';
const STORE = 'scores';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const listScores = async () =>
  ((await run('readonly', (s) => s.getAll())) || []).sort((a, b) => b.opened - a.opened);
export const getScore = (id) => run('readonly', (s) => s.get(id));
export const putScore = (score) => run('readwrite', (s) => s.put(score));
export const deleteScore = (id) => run('readwrite', (s) => s.delete(id));
