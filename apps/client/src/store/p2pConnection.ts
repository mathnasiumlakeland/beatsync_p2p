"use client";

import { joinRoom, selfId } from "trystero";
import { create } from "zustand";
import { prepareRoomCacheSnapshot } from "@/p2p/audio/availableSources";
import { initP2PAudioTransfer, resetP2PAudioTransfer } from "@/p2p/audio/transfer";
import { P2PRoomCoordinator } from "@/p2p/host/P2PRoomCoordinator";
import { chooseHostClaim, successorPeerId, type HostClaim } from "@/p2p/host/election";
import { parseP2PEnvelope } from "@/p2p/protocol";
import { loadRoomCache, saveRoomCache, type RoomCacheSnapshot } from "@/p2p/roomCache";
import { toTrysteroRoomId } from "@/p2p/constants";
import { createPeerUITransport } from "@/p2p/uiTransport";
import { useGlobalStore } from "@/store/global";
import type { P2PEnvelope, P2PRequestEnvelope, WSRequestType, WSResponseType } from "@beatsync/shared";

type TrysteroRoom = ReturnType<typeof joinRoom>;
type Session = { clientId: string; username: string };
type Hello = { clientId: string; username: string; hostId: string; term: number };
interface AttachSessionParams extends Session {
  room: TrysteroRoom;
  roomCode: string;
}
interface P2PConnectionState {
  room: TrysteroRoom | null;
  trysteroRoomId: string | null;
  roomCode: string | null;
  session: Session | null;
  connectedPeerIds: string[];
  coordinator: P2PRoomCoordinator | null;
  hostPeerId: string | null;
  isHost: boolean;
  isReady: boolean;
  connectionError: string | null;
  onServerMessage: ((message: WSResponseType) => void) | null;
  attachSession: (params: AttachSessionParams) => void;
  detachSession: () => void;
  sendRequest: (request: WSRequestType) => void;
  runRoomSync: () => void;
  requestRoomSync: () => void;
  pushPlaylistToAllPeers: () => void;
  handleIncomingEnvelope: (envelope: P2PEnvelope, fromPeerId: string) => void;
  setOnServerMessage: (handler: (message: WSResponseType) => void) => void;
}

let cleanupSession: (() => void) | null = null;
let send: ((envelope: P2PEnvelope, target?: string | null) => void) | null = null;
const identities = new Map<string, Session>();

export const useP2PConnectionStore = create<P2PConnectionState>()((set, get) => ({
  room: null,
  trysteroRoomId: null,
  roomCode: null,
  session: null,
  connectedPeerIds: [],
  coordinator: null,
  hostPeerId: null,
  isHost: false,
  isReady: false,
  connectionError: null,
  onServerMessage: null,
  setOnServerMessage: (handler) => set({ onServerMessage: handler }),

  attachSession: ({ room, roomCode, clientId, username }) => {
    if (get().room === room && get().session?.clientId === clientId) return;
    get().detachSession();
    // Capture the prior queue before any new session state can be persisted.
    const cachedAtAttach = loadRoomCache(roomCode);
    let active = true;
    let claim: HostClaim | null = null;
    let highestTerm = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const peers = new Set([selfId, ...Object.keys(room.getPeers())]);
    identities.set(selfId, { clientId, username });
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (active) fn();
      }, ms);
      timers.add(timer);
    };
    const envelopeAction = room.makeAction<P2PEnvelope>("envelope");
    envelopeAction.onReceive = ({ byteLength }) => byteLength <= 2 * 1024 * 1024;
    const presenceAction = room.makeAction<Hello>("presence");
    presenceAction.onReceive = ({ byteLength }) => byteLength <= 4096;
    send = (envelope, target = null) => {
      if (active)
        void envelopeAction.send(envelope, { target }).catch((error) => console.warn("[P2P] Send failed", error));
    };
    const deliver = (message: WSResponseType) => {
      if (!active) return;
      try {
        get().onServerMessage?.(message);
      } catch (error) {
        console.error("[P2P] Could not apply room update", error);
      }
    };
    const coordinator = new P2PRoomCoordinator(roomCode, {
      getSelfPeerId: () => selfId,
      getConnectedPeerIds: () => [...peers],
      onLocalClientListChange: (clients) => {
        if (!get().isHost) return;
        const message: WSResponseType = { type: "ROOM_EVENT", event: { type: "CLIENT_CHANGE", clients } };
        deliver(message);
        send?.({ kind: "broadcast", payload: message });
      },
      broadcast: (envelope) => {
        if (get().isHost) {
          deliver(envelope.payload);
          send?.(envelope);
        }
      },
      unicast: (envelope) => {
        if (!get().isHost) return;
        if (envelope.toPeerId === selfId) deliver(envelope.payload);
        else send?.(envelope, envelope.toPeerId);
      },
      direct: (envelope) => {
        if (!get().isHost) return;
        if (envelope.toPeerId === selfId) deliver(envelope.payload);
        else send?.(envelope, envelope.toPeerId);
      },
      stateSnapshot: (target, envelope) => {
        if (get().isHost) send?.(envelope, target);
      },
    });
    coordinator.registerSelf({ peerId: selfId, clientId, username, isAdmin: false });
    initP2PAudioTransfer(room);
    set({
      room,
      roomCode,
      session: { clientId, username },
      coordinator,
      trysteroRoomId: toTrysteroRoomId(roomCode),
      connectedPeerIds: [...peers],
      hostPeerId: null,
      isHost: false,
      isReady: true,
      connectionError: null,
    });
    useGlobalStore.setState({ socket: createPeerUITransport((request) => get().sendRequest(request)) });

    const announce = (target: string | null = null) => {
      if (!active) return;
      void presenceAction
        .send({ clientId, username, hostId: claim?.hostId ?? "", term: claim?.term ?? 0 }, { target })
        .catch(() => {});
    };
    const registerIdentities = () => {
      for (const [peerId, identity] of identities)
        coordinator.registerPeer({
          peerId,
          ...identity,
          isCreator: false,
          isAdmin: peerId === claim?.hostId,
        });
      if (claim) coordinator.setAuthority(claim.hostId);
    };
    const adopt = (next: HostClaim) => {
      if (!active || (claim?.hostId === next.hostId && claim.term === next.term)) return;
      const previousHost = claim?.hostId;
      claim = next;
      highestTerm = Math.max(highestTerm, next.term);
      set({ hostPeerId: next.hostId, isHost: next.hostId === selfId });
      const global = useGlobalStore.getState();
      const position = global.getCurrentTrackPosition();
      if (global.isPlaying) global.pauseAudio({ when: 0 });
      global.resetNTPConfig();
      coordinator.resetPlaybackForHostChange(position);
      registerIdentities();
      if (next.hostId === selfId) coordinator.hydrateLocalConsumer(deliver);
      announce();
      if (previousHost) set({ connectionError: null });
      later(() => get().requestRoomSync(), 150);
    };
    presenceAction.onMessage = (hello, { peerId: fromPeerId }) => {
      if (
        !active ||
        !peers.has(fromPeerId) ||
        typeof hello?.clientId !== "string" ||
        typeof hello.username !== "string" ||
        hello.clientId.length > 100 ||
        hello.username.length > 80
      )
        return;
      // The sender's transport identity is authoritative; envelope IDs cannot impersonate the host.
      if ([...identities].some(([id, identity]) => id !== fromPeerId && identity.clientId === hello.clientId)) return;
      const firstHello = !identities.has(fromPeerId);
      identities.set(fromPeerId, { clientId: hello.clientId, username: hello.username });
      const preferred = chooseHostClaim(
        [...(claim ? [claim] : []), { hostId: hello.hostId, term: hello.term }],
        [...peers]
      );
      if (preferred) adopt(preferred);
      registerIdentities();
      if (firstHello) {
        announce(fromPeerId);
        if (get().isHost) coordinator.onPeerJoined(fromPeerId);
        else get().requestRoomSync();
      }
    };
    envelopeAction.onMessage = (data, { peerId: fromPeerId }) => {
      if (!active) return;
      try {
        get().handleIncomingEnvelope(parseP2PEnvelope(data), fromPeerId);
      } catch (error) {
        console.warn("[P2P] Rejected invalid message", error);
      }
    };
    room.onPeerJoin = (peerId) => {
      if (!active) return;
      peers.add(peerId);
      set({ connectedPeerIds: [...peers], connectionError: null });
      announce(peerId);
      later(() => announce(peerId), 600);
    };
    room.onPeerLeave = (peerId) => {
      if (!active) return;
      peers.delete(peerId);
      identities.delete(peerId);
      coordinator.removePeer(peerId);
      set({ connectedPeerIds: [...peers] });
      if (claim?.hostId === peerId) {
        const successor = successorPeerId([...peers]);
        if (successor) adopt({ hostId: successor, term: highestTerm + 1 });
      }
    };
    const pulse = setInterval(() => announce(), 4000);
    cleanupSession = () => {
      active = false;
      clearInterval(pulse);
      for (const timer of timers) clearTimeout(timer);
    };
    // Restore only this browser's playable cache. A connected host always replaces it.
    void (async () => {
      try {
        const cache = cachedAtAttach;
        if (cache) {
          const snapshot = await prepareRoomCacheSnapshot(cache, "local-session");
          if (active && !claim)
            coordinator.applySnapshot({ ...snapshot, playbackState: { ...snapshot.playbackState, type: "paused" } });
        }
      } catch (error) {
        console.warn("[P2P] Browser cache unavailable", error);
      }
      if (!active) return;
      announce();
      later(() => {
        if (!claim) {
          const hostId = successorPeerId([...peers]);
          if (hostId) adopt({ hostId, term: highestTerm + 1 });
        }
      }, 1800);
    })();
  },

  detachSession: () => {
    cleanupSession?.();
    cleanupSession = null;
    send = null;
    get().coordinator?.destroy();
    resetP2PAudioTransfer();
    identities.clear();
    useGlobalStore.setState({ socket: null });
    set({
      room: null,
      roomCode: null,
      trysteroRoomId: null,
      session: null,
      coordinator: null,
      connectedPeerIds: [],
      hostPeerId: null,
      isHost: false,
      isReady: false,
    });
  },
  runRoomSync: () => get().sendRequest({ type: "SYNC" }),
  requestRoomSync: () => get().sendRequest({ type: "SYNC" }),
  // Track data is requested on demand, never repeatedly pushed as a whole playlist.
  pushPlaylistToAllPeers: () => {},
  sendRequest: (payload) => {
    if (
      ["IMPORT_YOUTUBE", "SAVE_YOUTUBE_PLAYLIST", "REFRESH_PLAYLIST", "SEARCH_MUSIC", "STREAM_MUSIC"].includes(
        payload.type
      )
    ) {
      throw new Error("This feature requires the BeatSync server edition. Upload local audio instead.");
    }
    const { session, hostPeerId, isHost, coordinator } = get();
    if (!session || !hostPeerId || !coordinator) return;
    const envelope: P2PRequestEnvelope = { kind: "request", fromPeerId: selfId, ...session, payload };
    if (isHost) get().handleIncomingEnvelope(envelope, selfId);
    else send?.(envelope, hostPeerId);
  },
  handleIncomingEnvelope: (envelope, fromPeerId) => {
    const { coordinator, hostPeerId, isHost, onServerMessage, roomCode } = get();
    if (!coordinator || !hostPeerId) return;
    if (envelope.kind === "request") {
      const identity = identities.get(fromPeerId);
      if (!isHost || !identity) return;
      const request = { ...envelope, fromPeerId, ...identity };
      switch (request.payload.type) {
        case "NTP_REQUEST":
          coordinator.handleRemoteNtp(request);
          return;
        case "SYNC":
          coordinator.handleRemoteSync(request);
          return;
        case "AUDIO_SOURCE_LOADED":
          coordinator.handleRemoteAudioLoaded(identity.clientId, request.payload.source.url);
          return;
        default:
          void coordinator.handleInitiatorRequest(request);
          return;
      }
    }
    // Only the elected host can publish playback, roster or queue state.
    if (fromPeerId !== hostPeerId) return;
    if (envelope.kind === "state-snapshot") {
      const snapshot = envelope.snapshot as RoomCacheSnapshot;
      coordinator.applySnapshot(snapshot);
      if (roomCode) saveRoomCache(roomCode, snapshot);
      return;
    }
    if (envelope.kind !== "broadcast" && envelope.toPeerId !== selfId) return;
    coordinator.applyHostMessage(envelope.payload);
    onServerMessage?.(envelope.payload);
  },
}));
