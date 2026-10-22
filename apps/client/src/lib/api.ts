import { normalizeAudioMimeType, isSupportedAudioFile } from "@/lib/audioFormats";
import { IS_P2P_MODE } from "@/lib/p2p";
import { MAX_TRACK_BYTES, ensureP2PTrackLocal } from "@/p2p/audio/transfer";
import { saveLocalTrack } from "@/p2p/audio/localTracks";
import { toP2PTrackUrl } from "@/p2p/audio/urls";
import { useGlobalStore } from "@/store/global";
import { useP2PConnectionStore } from "@/store/p2pConnection";
import type { DiscoverRoomsType, GetActiveRoomsType, GetDefaultAudioType } from "@beatsync/shared";
import { ClientActionEnum } from "@beatsync/shared";
import { nanoid } from "nanoid";
import { isP2PTrackUrl, parseP2PTrackId } from "@/p2p/audio/urls";

export const uploadAudioFile = async (data: { file: File; roomId: string }) => {
  if (!IS_P2P_MODE) {
    throw new Error("Server upload is disabled in this fork. Use P2P mode.");
  }

  const connection = useP2PConnectionStore.getState();
  const state = useGlobalStore.getState();
  if (!connection.isReady || !connection.hostPeerId) throw new Error("The room is still connecting");
  if (!state.currentUser?.isAdmin && state.playbackControlsPermissions !== "EVERYONE")
    throw new Error("Only admins can add audio in this room");
  if (!isSupportedAudioFile(data.file)) throw new Error("Choose a supported audio file (MP3 recommended)");
  if (data.file.size > MAX_TRACK_BYTES) throw new Error("Choose audio smaller than 64 MB");
  if (!data.file.size) throw new Error("This file is empty");
  const trackId = nanoid();
  const url = toP2PTrackUrl(trackId);
  const mimeType = normalizeAudioMimeType(data.file.type, data.file.name);
  const record = {
    trackId,
    fileName: data.file.name,
    mimeType,
    blob: data.file.type ? data.file : new Blob([data.file], { type: mimeType }),
    createdAt: Date.now(),
  };

  await saveLocalTrack(record);

  const p2p = useP2PConnectionStore.getState();
  if (!p2p.isReady) {
    throw new Error("Room connection is still starting — try again in a moment");
  }

  const durationSeconds = await readFileDuration(data.file);
  p2p.sendRequest({
    type: ClientActionEnum.enum.REGISTER_AUDIO_SOURCE,
    source: {
      url,
      name: data.file.name,
      title: data.file.name.replace(/\.[^/.]+$/, ""),
      sourceKind: "upload",
      metadata: durationSeconds > 0 ? { durationSeconds } : undefined,
    },
  });

  return { success: true, publicUrl: url };
};

export const fetchAudio = async (url: string) => {
  if (isP2PTrackUrl(url)) {
    const trackId = parseP2PTrackId(url);
    if (!trackId) throw new Error("Invalid P2P track URL");
    const record = await ensureP2PTrackLocal(trackId);
    return record.blob;
  }

  throw new Error("Only local peer audio files are supported");
};

export async function fetchDefaultAudioSources(): Promise<GetDefaultAudioType> {
  return [];
}

export async function fetchActiveRooms(): Promise<GetActiveRoomsType> {
  return 0;
}

export async function fetchDiscoverRooms(): Promise<DiscoverRoomsType> {
  return [];
}

function readFileDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const audio = new Audio();
    const finish = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      clearTimeout(timeout);
      audio.onloadedmetadata = null;
      audio.onerror = null;
      audio.src = "";
      URL.revokeObjectURL(objectUrl);
      resolve(duration);
    };
    const timeout = setTimeout(finish, 4000);
    audio.onloadedmetadata = finish;
    audio.onerror = finish;
    audio.preload = "metadata";
    audio.src = objectUrl;
  });
}
