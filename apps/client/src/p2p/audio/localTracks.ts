const DB_NAME = "beatsync-p2p";
const STORE_NAME = "tracks";
const DB_VERSION = 1;

export interface LocalTrackRecord {
  trackId: string;
  fileName: string;
  mimeType: string;
  blob: Blob;
  createdAt: number;
}

// Storage can be unavailable or reject Blob writes on mobile browsers. Keep a
// bounded session cache so persistence is never a prerequisite for listening.
const sessionTracks = new Map<string, LocalTrackRecord>();
const MAX_SESSION_BYTES = 128 * 1024 * 1024;
let warnedAboutStorage = false;
function rememberTrack(record: LocalTrackRecord): void {
  sessionTracks.delete(record.trackId);
  sessionTracks.set(record.trackId, record);
  let bytes = [...sessionTracks.values()].reduce((total, track) => total + track.blob.size, 0);
  for (const [id, track] of sessionTracks) {
    if (bytes <= MAX_SESSION_BYTES) break;
    sessionTracks.delete(id);
    bytes -= track.blob.size;
  }
}
function storageUnavailable(error: unknown): void {
  if (warnedAboutStorage) return;
  warnedAboutStorage = true;
  console.warn("[P2P] Persistent audio cache unavailable; using session memory", error);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("p2p-audio-cache-unavailable"));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "trackId" });
      }
    };
  });
}

async function persistLocalTrack(record: LocalTrackRecord): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB write failed"));
    };
    tx.objectStore(STORE_NAME).put(record);
  });
}

async function readLocalTrack(trackId: string): Promise<LocalTrackRecord | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB read failed"));
    };
    const request = tx.objectStore(STORE_NAME).get(trackId);
    request.onsuccess = () => {
      db.close();
      resolve((request.result as LocalTrackRecord | undefined) ?? null);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB get failed"));
  });
}

async function removeLocalTrack(trackId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onabort = tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("IndexedDB delete failed"));
    };
    tx.objectStore(STORE_NAME).delete(trackId);
  });
}

export async function saveLocalTrack(record: LocalTrackRecord): Promise<void> {
  rememberTrack(record);
  try {
    await persistLocalTrack(record);
  } catch (error) {
    storageUnavailable(error);
  }
}

export async function getLocalTrack(trackId: string): Promise<LocalTrackRecord | null> {
  const cached = sessionTracks.get(trackId);
  if (cached) {
    rememberTrack(cached);
    return cached;
  }
  try {
    return await readLocalTrack(trackId);
  } catch (error) {
    storageUnavailable(error);
    return null;
  }
}

export async function deleteLocalTrack(trackId: string): Promise<void> {
  sessionTracks.delete(trackId);
  try {
    await removeLocalTrack(trackId);
  } catch (error) {
    storageUnavailable(error);
  }
}
