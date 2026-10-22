import { afterEach, expect, test } from "bun:test";
import { deleteLocalTrack, getLocalTrack, saveLocalTrack, type LocalTrackRecord } from "../audio/localTracks";

const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
afterEach(() => {
  if (originalIndexedDB) Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
  else Reflect.deleteProperty(globalThis, "indexedDB");
});
function unavailableStorage() {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        throw new DOMException("Storage denied", "SecurityError");
      },
    },
  });
}
function track(trackId: string, bytes = 8): LocalTrackRecord {
  return {
    trackId,
    fileName: "test.wav",
    mimeType: "audio/wav",
    blob: new Blob([new Uint8Array(bytes)]),
    createdAt: 0,
  };
}

test("audio remains readable and removable when browser storage is denied", async () => {
  unavailableStorage();
  expect(await getLocalTrack("not-cached")).toBeNull();
  const record = track("memory-only");
  await saveLocalTrack(record);
  expect(await (await getLocalTrack(record.trackId))?.blob.arrayBuffer()).toEqual(await record.blob.arrayBuffer());
  await deleteLocalTrack(record.trackId);
  expect(await getLocalTrack(record.trackId)).toBeNull();
});

test("failed IndexedDB transactions still leave playable session audio", async () => {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request: any = {};
        queueMicrotask(() => {
          request.result = {
            close() {},
            transaction() {
              const tx: any = {
                error: new DOMException("Quota exceeded", "QuotaExceededError"),
                objectStore() {
                  return {
                    put() {
                      queueMicrotask(() => tx.onabort());
                    },
                  };
                },
              };
              return tx;
            },
          };
          request.onsuccess();
        });
        return request;
      },
    },
  });
  const record = track("quota-failure");
  await saveLocalTrack(record);
  expect((await getLocalTrack(record.trackId))?.blob.size).toBe(8);
});

test("session audio fallback evicts oldest files within its memory bound", async () => {
  unavailableStorage();
  await saveLocalTrack(track("old", 64 * 1024 * 1024));
  await saveLocalTrack(track("middle", 64 * 1024 * 1024));
  await saveLocalTrack(track("new", 8));
  expect(await getLocalTrack("old")).toBeNull();
  expect((await getLocalTrack("middle"))?.blob.size).toBe(64 * 1024 * 1024);
  expect((await getLocalTrack("new"))?.blob.size).toBe(8);
  await deleteLocalTrack("middle");
  await deleteLocalTrack("new");
});
