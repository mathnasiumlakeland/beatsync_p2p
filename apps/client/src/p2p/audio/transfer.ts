import { normalizeAudioMimeType } from "@/lib/audioFormats";
import { parseP2PTrackId } from "@/p2p/audio/urls";
import { getLocalTrack, saveLocalTrack, type LocalTrackRecord } from "@/p2p/audio/localTracks";
import { nanoid } from "nanoid";
import { joinRoom } from "trystero";
import { create } from "zustand";

type TrysteroRoom = ReturnType<typeof joinRoom>;
export const MAX_TRACK_BYTES = 64 * 1024 * 1024;
const TRACK_REQUEST_TIMEOUT_MS = 120_000;
type TrackQuery = { trackId: string; requestId: string };
type TrackOffer = TrackQuery & { fileName: string; size: number };
export interface TrackTransferMeta extends TrackOffer {
  mimeType: string;
}
type TransferStatus = { fileName: string; progress: number; error?: string };
export const useTransferStore = create<{ transfers: Record<string, TransferStatus> }>(() => ({ transfers: {} }));

interface PendingTrack {
  requestId: string;
  peerId: string | null;
  size: number;
  resolve: (track: LocalTrackRecord) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
const pendingTracks = new Map<string, PendingTrack>();
const inFlight = new Map<string, Promise<LocalTrackRecord>>();
let initializedRoom: TrysteroRoom | null = null;
let findTrack: ((query: TrackQuery) => Promise<unknown>) | null = null;
let generation = 0;

function updateProgress(trackId: string, value: TransferStatus) {
  useTransferStore.setState((state) => ({ transfers: { ...state.transfers, [trackId]: value } }));
}
function finish(trackId: string, error?: Error, record?: LocalTrackRecord) {
  const pending = pendingTracks.get(trackId);
  if (!pending) return;
  pendingTracks.delete(trackId);
  pending.cleanup();
  if (error) {
    updateProgress(trackId, {
      fileName: useTransferStore.getState().transfers[trackId]?.fileName ?? "Audio",
      progress: 0,
      error: error.message,
    });
    pending.reject(error);
  } else if (record) {
    useTransferStore.setState((state) => {
      const transfers = { ...state.transfers };
      delete transfers[trackId];
      return { transfers };
    });
    pending.resolve(record);
  }
}

export function resetP2PAudioTransfer(): void {
  generation++;
  for (const trackId of pendingTracks.keys()) finish(trackId, new Error("Room connection closed"));
  inFlight.clear();
  initializedRoom = null;
  findTrack = null;
  useTransferStore.setState({ transfers: {} });
}

export function initP2PAudioTransfer(room: TrysteroRoom): void {
  if (initializedRoom === room) return;
  resetP2PAudioTransfer();
  initializedRoom = room;
  const session = generation;
  const dataAction = room.makeAction<ArrayBuffer>("audio-track");
  const findAction = room.makeAction<TrackQuery>("track-find");
  const offerAction = room.makeAction<TrackOffer>("track-have");
  const requestAction = room.makeAction<TrackQuery>("track-get");
  const sending = new Set<string>();
  findTrack = (query) => findAction.send(query);
  for (const action of [findAction, offerAction, requestAction])
    action.onReceive = ({ byteLength }) => byteLength <= 4096;
  dataAction.onReceive = ({ peerId, byteLength, metadata }) => {
    const meta = metadata as TrackTransferMeta | undefined;
    const pending = meta && pendingTracks.get(meta.trackId);
    return (
      !!pending &&
      pending.peerId === peerId &&
      pending.requestId === meta?.requestId &&
      byteLength === pending.size &&
      byteLength > 0 &&
      byteLength <= MAX_TRACK_BYTES
    );
  };

  findAction.onMessage = (query, { peerId }) => {
    if (!validQuery(query)) return;
    void getLocalTrack(query.trackId)
      .then((record) => {
        if (session !== generation || !record || record.blob.size > MAX_TRACK_BYTES) return;
        return offerAction.send({ ...query, fileName: record.fileName, size: record.blob.size }, { target: peerId });
      })
      .catch((error) => console.warn("[P2P] Cannot offer cached track", error));
  };
  offerAction.onMessage = (offer, { peerId }) => {
    const pending = pendingTracks.get(offer?.trackId);
    if (
      !pending ||
      pending.requestId !== offer.requestId ||
      pending.peerId ||
      !Number.isSafeInteger(offer.size) ||
      offer.size <= 0 ||
      offer.size > MAX_TRACK_BYTES
    )
      return;
    pending.peerId = peerId;
    pending.size = offer.size;
    updateProgress(offer.trackId, { fileName: offer.fileName, progress: 0 });
    void requestAction
      .send({ trackId: offer.trackId, requestId: offer.requestId }, { target: peerId })
      .catch((error) => finish(offer.trackId, new Error(String(error))));
  };
  requestAction.onMessage = (query, { peerId }) => {
    if (!validQuery(query)) return;
    const key = `${peerId}:${query.requestId}`;
    if (sending.has(key)) return;
    sending.add(key);
    void (async () => {
      const record = await getLocalTrack(query.trackId);
      if (!record || session !== generation || record.blob.size > MAX_TRACK_BYTES) return;
      const metadata = {
        ...query,
        fileName: record.fileName,
        size: record.blob.size,
        mimeType: normalizeAudioMimeType(record.mimeType, record.fileName),
      };
      await dataAction.send(await record.blob.arrayBuffer(), { target: peerId, metadata });
    })()
      .catch((error) => console.warn("[P2P] Track send interrupted", error))
      .finally(() => sending.delete(key));
  };
  dataAction.onReceiveProgress = (progress, { peerId, metadata }) => {
    const meta = metadata as TrackTransferMeta | undefined;
    const pending = meta && pendingTracks.get(meta.trackId);
    if (pending && pending.peerId === peerId && pending.requestId === meta?.requestId)
      updateProgress(meta.trackId, { fileName: meta.fileName, progress: Math.max(0, Math.min(1, progress)) });
  };
  dataAction.onMessage = (data, { peerId, metadata }) => {
    const meta = metadata as TrackTransferMeta | undefined;
    const pending = meta && pendingTracks.get(meta.trackId);
    if (
      !meta ||
      !pending ||
      session !== generation ||
      pending.peerId !== peerId ||
      pending.requestId !== meta.requestId
    )
      return;
    if (data.byteLength !== pending.size || data.byteLength > MAX_TRACK_BYTES) {
      finish(meta.trackId, new Error("Audio transfer size mismatch"));
      return;
    }
    const mimeType = normalizeAudioMimeType(meta.mimeType, meta.fileName);
    const record: LocalTrackRecord = {
      trackId: meta.trackId,
      fileName: meta.fileName,
      mimeType,
      blob: new Blob([data], { type: mimeType }),
      createdAt: Date.now(),
    };
    void saveLocalTrack(record)
      .then(() => {
        if (session !== generation) return;
        finish(meta.trackId, undefined, record);
        window.dispatchEvent(new CustomEvent("p2p-track-received", { detail: { trackId: meta.trackId } }));
      })
      .catch((error) => finish(meta.trackId, new Error(`Cannot cache audio: ${String(error)}`)));
  };
}

function validQuery(query: TrackQuery): boolean {
  return (
    typeof query?.trackId === "string" &&
    /^[\w-]{1,80}$/.test(query.trackId) &&
    typeof query.requestId === "string" &&
    /^[\w-]{1,80}$/.test(query.requestId)
  );
}

export async function ensureP2PTrackLocal(trackId: string): Promise<LocalTrackRecord> {
  const session = generation;
  const existing = await getLocalTrack(trackId);
  if (session !== generation) throw new Error("Room connection changed");
  if (existing) return existing;
  if (!findTrack) throw new Error("Room connection is not ready");
  const previous = inFlight.get(trackId);
  if (previous) return previous;
  const promise = new Promise<LocalTrackRecord>((resolve, reject) => {
    const requestId = nanoid();
    const query = () => {
      if (!pendingTracks.get(trackId)?.peerId) void findTrack?.({ trackId, requestId }).catch(() => {});
    };
    const timeout = setTimeout(
      () =>
        finish(
          trackId,
          new Error("Audio unavailable. Keep a device with this track connected, or ask the host to add it again.")
        ),
      TRACK_REQUEST_TIMEOUT_MS
    );
    const retry = setInterval(() => {
      const pending = pendingTracks.get(trackId);
      if (pending?.peerId && !initializedRoom?.getPeers()[pending.peerId]) pending.peerId = null;
      query();
    }, 4000);
    pendingTracks.set(trackId, {
      requestId,
      peerId: null,
      size: 0,
      resolve,
      reject,
      cleanup: () => {
        clearTimeout(timeout);
        clearInterval(retry);
      },
    });
    updateProgress(trackId, { fileName: "Finding audio on nearby devices", progress: 0 });
    query();
  }).finally(() => {
    if (inFlight.get(trackId) === promise) inFlight.delete(trackId);
  });
  inFlight.set(trackId, promise);
  return promise;
}

export async function loadP2PTrackArrayBuffer(url: string): Promise<ArrayBuffer> {
  const trackId = parseP2PTrackId(url);
  if (!trackId) throw new Error(`Invalid local track: ${url}`);
  return (await ensureP2PTrackLocal(trackId)).blob.arrayBuffer();
}
