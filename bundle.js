  function openDB(options = {}) {
    const { allowReset = true } = options;
        const db = req.result;
        const missingStores = Object.keys(STORE_KEY_PATHS).filter((name) => !db.objectStoreNames.contains(name));
        if (missingStores.length && allowReset) {
          try {
            db.close();
          } catch (err) {
            console.warn("Failed to close corrupted IndexedDB connection", err);
          }
          const deleteReq = indexedDB.deleteDatabase(DB_NAME);
          deleteReq.onsuccess = () => {
            resolve(openDB({ allowReset: false }));
          };
          deleteReq.onerror = () => {
            resolve(fallbackToMemory("IndexedDB missing stores and deletion failed, using in-memory storage.", deleteReq.error));
          };
          deleteReq.onblocked = () => {
            resolve(fallbackToMemory("IndexedDB deletion blocked, using in-memory storage."));
          };
          return;
        }
        resolve(db);
