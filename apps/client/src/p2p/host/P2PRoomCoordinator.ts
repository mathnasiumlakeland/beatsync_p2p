import {
  coerceP2PPlaybackPermissions,
  isP2PEqualPeerMode,
  normalizeP2PClient,
  P2P_DEFAULT_PLAYBACK_PERMISSIONS,
} from "@/p2p/permissions";
import { isP2PTrackUrl } from "@/p2p/audio/urls";
import { ChatManager } from "@/p2p/host/ChatManager";
import { computeCacheRichness, type RoomCacheSnapshot, saveRoomCache } from "@/p2p/roomCache";
import { calculateGainFromDistanceToSource } from "@/p2p/spatial";
import type { P2PStateSnapshotEnvelope } from "@beatsync/shared";
import type {
  AudioSourceType,
  PlaylistType,
  ClientDataType,
  P2PBroadcastEnvelope,
  P2PDirectEnvelope,
  P2PRequestEnvelope,
  P2PUnicastEnvelope,
  PauseActionType,
  PlayActionType,
  PlaybackControlsPermissionsType,
  PositionType,
  WSResponseType,
  WSRequestType,
} from "@beatsync/shared";
import {
  calculateScheduleTimeMs,
  epochNow,
  GRID,
  LOW_PASS_CONSTANTS,
  PlaybackControlsPermissionsEnum,
  positionClientsInCircle,
} from "@beatsync/shared";

export interface P2PRoomCoordinatorCallbacks {
  getSelfPeerId: () => string;
  getConnectedPeerIds: () => string[];
  /** Local UI only — never fan out roster snapshots (each peer has its own view). */
  onLocalClientListChange: (clients: ClientDataType[]) => void;
  broadcast: (envelope: P2PBroadcastEnvelope) => void;
  unicast: (envelope: P2PUnicastEnvelope) => void;
  direct: (envelope: P2PDirectEnvelope) => void;
  stateSnapshot: (targetPeerId: string | null, envelope: P2PStateSnapshotEnvelope) => void;
}

interface PeerSession {
  peerId: string;
  clientId: string;
  username: string;
  isCreator: boolean;
  isAdmin: boolean;
}

interface RoomPlaybackState {
  type: "playing" | "paused";
  audioSource: string;
  serverTimeToExecute: number;
  trackPositionSeconds: number;
}

interface PendingPlayState {
  clientsLoaded: Set<string>;
  timeout: ReturnType<typeof setTimeout>;
  playAction: PlayActionType;
}

const AUDIO_LOAD_TIMEOUT_MS = 30_000;

/** Room logic runs on every peer; the initiator of each action fans out broadcasts. */
export class P2PRoomCoordinator {
  private authorityPeerId: string | null = null;
  private readonly clients = new Map<string, ClientDataType>();
  private readonly peerSessions = new Map<string, PeerSession>();
  private readonly peerIdByClientId = new Map<string, string>();
  private audioSources: AudioSourceType[] = [];
  private playlists: PlaylistType[] = [];
  private isShuffled = false;
  private shuffleHistory: string[] = [];
  private listeningSource: PositionType = { x: GRID.ORIGIN_X, y: GRID.ORIGIN_Y };
  private playbackState: RoomPlaybackState = {
    type: "paused",
    audioSource: "",
    serverTimeToExecute: 0,
    trackPositionSeconds: 0,
  };
  private playbackControlsPermissions: PlaybackControlsPermissionsType = P2P_DEFAULT_PLAYBACK_PERMISSIONS;
  private globalVolume = 0.5;
  private lowPassFreq: number = LOW_PASS_CONSTANTS.MAX_FREQ;
  private isMetronomeEnabled = false;
  private spatialIntervalId?: ReturnType<typeof setInterval>;
  private pendingPlay?: PendingPlayState;
  private readonly chatManager = new ChatManager();

  constructor(
    private readonly roomCode: string,
    private readonly callbacks: P2PRoomCoordinatorCallbacks
  ) {}

  registerSelf(session: Omit<PeerSession, "isCreator" | "isAdmin"> & { isCreator?: boolean; isAdmin?: boolean }): void {
    this.registerPeer(
      {
        peerId: session.peerId,
        clientId: session.clientId,
        username: session.username,
        isCreator: session.isCreator ?? false,
        isAdmin: session.isAdmin ?? true,
      },
      { notify: false }
    );
  }

  registerPeer(session: PeerSession, options: { notify?: boolean } = {}): void {
    const shouldNotify = options.notify !== false;

    if (this.peerSessions.has(session.peerId)) {
      const client = this.clients.get(session.clientId);
      if (client) client.username = session.username;
      return;
    }

    this.peerSessions.set(session.peerId, session);
    this.peerIdByClientId.set(session.clientId, session.peerId);

    const prev = this.clients.get(session.clientId);
    const clientData: ClientDataType = normalizeP2PClient({
      joinedAt: prev?.joinedAt ?? Date.now(),
      username: session.username,
      clientId: session.clientId,
      // Everyone who joins this local room starts as an admin. Existing explicit changes survive presence updates.
      isAdmin: prev?.isAdmin ?? true,
      isCreator: session.isCreator,
      rtt: prev?.rtt ?? 0,
      compensationMs: prev?.compensationMs ?? 0,
      nudgeMs: prev?.nudgeMs ?? 0,
      position: prev?.position ?? { x: GRID.ORIGIN_X, y: GRID.ORIGIN_Y - 25 },
      lastNtpResponse: Date.now(),
      location: prev?.location,
    });

    if (!isP2PEqualPeerMode() && (session.isAdmin || session.isCreator)) {
      clientData.isAdmin = true;
    }

    this.clients.set(session.clientId, clientData);
    positionClientsInCircle(this.getActiveClients());
    if (shouldNotify) {
      this.notifyLocalClientListChange();
    }
  }

  removePeer(peerId: string): void {
    const session = this.peerSessions.get(peerId);
    if (!session) return;

    this.peerSessions.delete(peerId);
    this.peerIdByClientId.delete(session.clientId);
    this.clients.delete(session.clientId);

    const remaining = this.getActiveClients();
    if (remaining.length > 0) {
      positionClientsInCircle(remaining);
    } else {
      this.stopSpatialAudio();
    }

    this.notifyLocalClientListChange();
  }

  setAuthority(hostPeerId: string): void {
    this.authorityPeerId = hostPeerId;
    for (const [peerId, session] of this.peerSessions) {
      const client = this.clients.get(session.clientId);
      if (client && peerId === hostPeerId) client.isAdmin = true;
    }
    this.notifyLocalClientListChange();
  }

  resetPlaybackForHostChange(position: number): void {
    this.clearPendingPlay();
    this.playbackState = { ...this.playbackState, type: "paused", trackPositionSeconds: position };
    this.persistCache();
  }

  exportSnapshot(): RoomCacheSnapshot {
    return {
      version: 2,
      updatedAt: Date.now(),
      audioSources: [...this.audioSources],
      playlists: this.playlists,
      isShuffled: this.isShuffled,
      shuffleHistory: this.shuffleHistory,
      playbackState: { ...this.playbackState },
      playbackControlsPermissions: this.playbackControlsPermissions,
      globalVolume: this.globalVolume,
      lowPassFreq: this.lowPassFreq,
      isMetronomeEnabled: this.isMetronomeEnabled,
      chatMessages: this.chatManager.getFullHistory(),
      chatNextMessageId: this.chatManager.getNextMessageId(),
    };
  }

  applySnapshot(snapshot: RoomCacheSnapshot): void {
    this.audioSources = snapshot.audioSources.filter((source) => isP2PTrackUrl(source.url));
    this.playlists = (snapshot.playlists ?? []).map((playlist) => ({
      ...playlist,
      tracks: playlist.tracks.filter((track) => isP2PTrackUrl(track.url)),
      trackUrls: playlist.trackUrls.filter(isP2PTrackUrl),
    }));
    this.isShuffled = snapshot.isShuffled ?? false;
    this.shuffleHistory = snapshot.shuffleHistory ?? [];
    this.playbackState = { ...snapshot.playbackState };
    // Upgrade the old host-only default without discarding saved music or playlists.
    this.playbackControlsPermissions =
      snapshot.version < 2
        ? P2P_DEFAULT_PLAYBACK_PERMISSIONS
        : coerceP2PPlaybackPermissions(snapshot.playbackControlsPermissions);
    this.globalVolume = snapshot.globalVolume;
    this.lowPassFreq = snapshot.lowPassFreq;
    this.isMetronomeEnabled = snapshot.isMetronomeEnabled;
    this.chatManager.restoreFromHistory(snapshot.chatMessages, snapshot.chatNextMessageId);
    this.persistCache();
  }

  /** Apply playlist from a peer broadcast/direct snapshot (do not re-broadcast). */
  applyNetworkAudioSources(sources: AudioSourceType[], currentAudioSource?: string): void {
    this.audioSources = sources.filter((source) => isP2PTrackUrl(source.url));
    if (currentAudioSource && sources.some((s) => s.url === currentAudioSource)) {
      this.playbackState = {
        ...this.playbackState,
        audioSource: currentAudioSource,
      };
    } else if (currentAudioSource === undefined) {
      // omit — keep existing playback selection
    } else if (!sources.some((s) => s.url === this.playbackState.audioSource)) {
      this.playbackState = {
        type: "paused",
        audioSource: "",
        serverTimeToExecute: 0,
        trackPositionSeconds: 0,
      };
    }
    this.persistCache();
  }

  /** Keep a listener's replica ready for host handover, without publishing anything. */
  applyHostMessage(message: WSResponseType): void {
    if (message.type === "ROOM_EVENT") {
      const event = message.event;
      if (event.type === "SET_AUDIO_SOURCES") this.applyNetworkAudioSources(event.sources, event.currentAudioSource);
      if (event.type === "SET_PLAYLISTS") this.playlists = event.playlists;
      if (event.type === "SET_SHUFFLE") {
        this.isShuffled = event.enabled;
        this.shuffleHistory = event.shuffleHistory ?? [];
      }
      if (event.type === "SET_PLAYBACK_CONTROLS") this.playbackControlsPermissions = event.permissions;
      if (event.type === "CHAT_UPDATE") {
        const history = event.isFullSync ? event.messages : [...this.chatManager.getFullHistory(), ...event.messages];
        const unique = [...new Map(history.map((item) => [item.id, item])).values()];
        this.chatManager.restoreFromHistory(unique, Math.max(0, ...unique.map((item) => item.id)) + 1);
      }
      if (event.type === "CLIENT_CHANGE") {
        for (const client of event.clients) {
          if (this.peerIdByClientId.has(client.clientId)) this.clients.set(client.clientId, { ...client });
        }
      }
    }
    if (message.type === "SCHEDULED_ACTION") {
      const action = message.scheduledAction;
      switch (action.type) {
        case "PLAY":
        case "PAUSE":
          this.playbackState = {
            type: action.type === "PLAY" ? "playing" : "paused",
            audioSource: action.audioSource,
            trackPositionSeconds: action.trackTimeSeconds,
            serverTimeToExecute: message.serverTimeToExecute,
          };
          break;
        case "GLOBAL_VOLUME_CONFIG":
          this.globalVolume = action.volume;
          break;
        case "LOW_PASS_CONFIG":
          this.lowPassFreq = action.freq;
          break;
        case "METRONOME_CONFIG":
          this.isMetronomeEnabled = action.enabled;
          break;
      }
    }
    this.persistCache();
  }

  getSnapshotRichness(): number {
    return computeCacheRichness(this.exportSnapshot());
  }

  buildStateSnapshotEnvelope(fromPeerId: string): P2PStateSnapshotEnvelope {
    const snapshot = this.exportSnapshot();
    return {
      kind: "state-snapshot",
      fromPeerId,
      richness: computeCacheRichness(snapshot),
      snapshot: {
        ...snapshot,
        playlists: snapshot.playlists ?? [],
        isShuffled: snapshot.isShuffled ?? false,
        shuffleHistory: snapshot.shuffleHistory ?? [],
      },
    };
  }

  private persistCache(): void {
    saveRoomCache(this.roomCode, this.exportSnapshot());
  }

  getActiveClients(): ClientDataType[] {
    return [...this.clients.values()].filter((c) => this.peerIdByClientId.has(c.clientId));
  }

  /** Initiator-only room mutations (fan-out via broadcast payloads). */
  async handleInitiatorRequest(envelope: P2PRequestEnvelope): Promise<void> {
    this.registerPeer({
      peerId: envelope.fromPeerId,
      clientId: envelope.clientId,
      username: envelope.username,
      isCreator: false,
      isAdmin: false,
    });

    const { payload, clientId } = envelope;

    try {
      switch (payload.type) {
        case "NTP_REQUEST":
        case "SYNC":
          return;
        case "SEND_IP": {
          const client = this.clients.get(clientId);
          if (client) {
            client.location = payload.location;
            this.clients.set(clientId, client);
            this.notifyLocalClientListChange();
          }
          return;
        }
        case "SEND_CHAT_MESSAGE":
          this.handleChat(clientId, payload.text);
          return;
        case "PLAY": {
          if (this.canMutate(clientId)) this.handlePlay(clientId, payload);
          return;
        }
        case "PAUSE": {
          if (this.canMutate(clientId)) this.handlePause(payload);
          return;
        }
        case "AUDIO_SOURCE_LOADED":
          this.handleAudioSourceLoaded(clientId, payload.source.url);
          this.persistCache();
          return;
        case "REGISTER_AUDIO_SOURCE":
          if (this.canMutatePlaylist(clientId)) this.registerAudioSource(payload.source);
          return;
        case "DELETE_AUDIO_SOURCES":
          if (this.canMutatePlaylist(clientId)) this.deleteAudioSources(payload.urls);
          return;
        case "REORDER_AUDIO_SOURCES":
          if (this.canMutatePlaylist(clientId)) this.reorderAudioSources(payload.reorderedAudioSources);
          return;
        case "SET_GLOBAL_VOLUME":
          if (this.canMutate(clientId)) this.setGlobalVolume(payload.volume);
          return;
        case "SET_LOW_PASS_FREQ":
          if (this.canMutate(clientId)) this.setLowPassFreq(payload.freq);
          return;
        case "SET_METRONOME":
          if (this.canMutate(clientId)) this.setMetronome(payload.enabled);
          return;
        case "SET_PLAYBACK_CONTROLS":
          if (this.isAdmin(clientId)) this.setPlaybackControls(payload.permissions);
          return;
        case "SET_ADMIN":
          if (this.isAdmin(clientId)) this.setAdmin(payload.clientId, payload.isAdmin);
          return;
        case "SET_SHUFFLE":
          if (this.canMutate(clientId)) {
            this.isShuffled = payload.enabled;
            const available = new Set(this.audioSources.map((source) => source.url));
            this.shuffleHistory = (payload.shuffleHistory ?? []).filter((url) => available.has(url));
            this.broadcastShuffle();
            this.persistCache();
          }
          return;
        case "CLEAR_AUDIO_QUEUE":
          if (this.canMutatePlaylist(clientId)) {
            this.handlePause({ type: "PAUSE", audioSource: this.playbackState.audioSource, trackTimeSeconds: 0 });
            this.audioSources = [];
            this.playbackState.audioSource = "";
            this.broadcastAudioSources();
            this.persistCache();
          }
          return;
        case "CREATE_PLAYLIST":
        case "UPDATE_PLAYLIST":
        case "SET_PLAYLIST_TRACKS":
        case "DELETE_PLAYLIST":
        case "QUEUE_PLAYLIST":
        case "QUEUE_TRACKS":
        case "SET_DEFAULT_PLAYLIST":
          if (this.canMutatePlaylist(clientId)) this.mutateLibrary(payload);
          return;
        case "START_SPATIAL_AUDIO":
          if (this.canMutate(clientId)) this.startSpatialAudio();
          return;
        case "STOP_SPATIAL_AUDIO":
          if (this.canMutate(clientId)) this.stopSpatialAudio();
          return;
        case "MOVE_CLIENT":
          if (this.canMutate(clientId)) this.moveClient(payload.clientId, payload.position);
          return;
        case "SET_LISTENING_SOURCE":
          if (this.canMutate(clientId)) this.updateListeningSource(payload);
          return;
        case "REORDER_CLIENT":
          if (this.canMutate(clientId)) this.reorderClient(payload.clientId);
          return;
        case "SEARCH_MUSIC":
        case "STREAM_MUSIC":
          return;
        case "LOAD_DEFAULT_TRACKS": {
          if (!this.canMutatePlaylist(clientId)) return;
          const playlist = this.playlists.find((item) => item.isDefault);
          if (playlist) this.mutateLibrary({ type: "QUEUE_PLAYLIST", playlistId: playlist.id });
          return;
        }
        case "IMPORT_YOUTUBE":
        case "SAVE_YOUTUBE_PLAYLIST":
        case "REFRESH_PLAYLIST":
          // The Pages build intentionally has no downloader service.
          return;
        default:
          console.warn(`[P2P peer] Unhandled initiator request: ${(payload as { type: string }).type}`);
      }
    } finally {
      this.persistCache();
    }
  }

  handleRemoteNtp(envelope: P2PRequestEnvelope): void {
    if (envelope.payload.type !== "NTP_REQUEST") return;
    this.registerPeer({
      peerId: envelope.fromPeerId,
      clientId: envelope.clientId,
      username: envelope.username,
      isCreator: false,
      isAdmin: false,
    });
    this.respondNtp(envelope.fromPeerId, envelope.payload);
  }

  handleRemoteSync(envelope: P2PRequestEnvelope): void {
    this.registerPeer({
      peerId: envelope.fromPeerId,
      clientId: envelope.clientId,
      username: envelope.username,
      isCreator: false,
      isAdmin: false,
    });
    this.sendJoinSnapshot(envelope.fromPeerId);
    this.sendStateSnapshotUnicast(envelope.fromPeerId);
  }

  handleRemoteAudioLoaded(clientId: string, url: string): void {
    this.handleAudioSourceLoaded(clientId, url);
  }

  /** Push cached room state into the local UI (same payloads as late-join sync). */
  hydrateLocalConsumer(onMessage: (message: WSResponseType) => void): void {
    this.sendJoinSnapshot("__local__", onMessage);
  }

  broadcastStateSnapshot(): void {
    if (this.getSnapshotRichness() === 0) return;
    this.callbacks.stateSnapshot(null, this.buildStateSnapshotEnvelope(this.callbacks.getSelfPeerId()));
  }

  onPeerJoined(peerId: string): void {
    this.sendJoinSnapshot(peerId);
    this.sendStateSnapshotUnicast(peerId);
  }

  private sendStateSnapshotUnicast(peerId: string): void {
    if (peerId === "__local__" || this.getSnapshotRichness() === 0) return;
    this.callbacks.stateSnapshot(peerId, this.buildStateSnapshotEnvelope(this.callbacks.getSelfPeerId()));
  }

  private canMutate(clientId: string): boolean {
    if (isP2PEqualPeerMode()) return this.clients.has(clientId);
    const client = this.clients.get(clientId);
    if (!client) return false;
    return this.playbackControlsPermissions === PlaybackControlsPermissionsEnum.enum.EVERYONE || client.isAdmin;
  }

  /** Any peer in the roster may add/reorder/remove tracks (P2P uploads). */
  private canMutatePlaylist(clientId: string): boolean {
    return this.canMutate(clientId);
  }

  private isAdmin(clientId: string): boolean {
    return this.clients.get(clientId)?.isAdmin ?? false;
  }

  private getMaxClientRTT(): number {
    let max = 0;
    for (const client of this.getActiveClients()) {
      if (client.rtt > max) max = client.rtt;
    }
    return max;
  }

  private getMaxClientCompensation(): number {
    let max = 0;
    for (const client of this.getActiveClients()) {
      if (client.compensationMs > max) max = client.compensationMs;
    }
    return max;
  }

  private getScheduledExecutionTime(opts: { extraOffsetMs?: number } = {}): number {
    const maxRTT = this.getMaxClientRTT();
    const maxCompensation = this.getMaxClientCompensation();
    const baseDelayMs = calculateScheduleTimeMs(maxRTT);
    const scheduleDelayMs = Math.max(baseDelayMs, maxCompensation + 200);
    return epochNow() + scheduleDelayMs + (opts.extraOffsetMs ?? 0);
  }

  private respondNtp(peerId: string, msg: Extract<WSRequestType, { type: "NTP_REQUEST" }>): void {
    const t1 = epochNow();
    const session = this.peerSessions.get(peerId);
    if (session) {
      const client = this.clients.get(session.clientId);
      if (client) {
        if (msg.clientRTT !== undefined && msg.clientRTT > 0) {
          const alpha = 0.2;
          client.rtt = client.rtt > 0 ? client.rtt * (1 - alpha) + msg.clientRTT * alpha : msg.clientRTT;
        }
        if (msg.clientCompensationMs !== undefined) client.compensationMs = msg.clientCompensationMs;
        if (msg.clientNudgeMs !== undefined) client.nudgeMs = msg.clientNudgeMs;
        client.lastNtpResponse = Date.now();
        this.clients.set(session.clientId, client);
      }
    }

    this.callbacks.unicast({
      kind: "unicast",
      toPeerId: peerId,
      payload: {
        type: "NTP_RESPONSE",
        t0: msg.t0,
        t1,
        t2: epochNow(),
        probeGroupId: msg.probeGroupId,
        probeGroupIndex: msg.probeGroupIndex,
      },
    });
  }

  private sendJoinSnapshot(peerId: string, onMessage?: (message: WSResponseType) => void): void {
    const now = epochNow();
    const deliverDirect = (payload: P2PDirectEnvelope["payload"]) => {
      if (onMessage) onMessage(payload);
      else this.callbacks.direct({ kind: "direct", toPeerId: peerId, payload });
    };
    const deliverUnicast = (payload: P2PUnicastEnvelope["payload"]) => {
      if (onMessage) onMessage(payload);
      else this.callbacks.unicast({ kind: "unicast", toPeerId: peerId, payload });
    };

    {
      deliverDirect({
        type: "ROOM_EVENT",
        event: {
          type: "SET_AUDIO_SOURCES",
          sources: this.audioSources,
          currentAudioSource: this.playbackState.audioSource || undefined,
        },
      });
    }

    deliverDirect({ type: "ROOM_EVENT", event: { type: "SET_PLAYLISTS", playlists: this.playlists } });
    deliverDirect({
      type: "ROOM_EVENT",
      event: { type: "SET_SHUFFLE", enabled: this.isShuffled, shuffleHistory: this.shuffleHistory },
    });
    deliverDirect({
      type: "ROOM_EVENT",
      event: { type: "CLIENT_CHANGE", clients: this.getActiveClients() },
    });

    deliverDirect({
      type: "ROOM_EVENT",
      event: {
        type: "SET_PLAYBACK_CONTROLS",
        permissions: this.playbackControlsPermissions,
      },
    });

    const chat = this.chatManager.getFullHistory();
    if (chat.length > 0) {
      deliverDirect({
        type: "ROOM_EVENT",
        event: {
          type: "CHAT_UPDATE",
          messages: chat,
          isFullSync: true,
          newestId: this.chatManager.getNewestId(),
        },
      });
    }

    deliverUnicast({
      type: "SCHEDULED_ACTION",
      serverTimeToExecute: now,
      scheduledAction: {
        type: "GLOBAL_VOLUME_CONFIG",
        volume: this.globalVolume,
        rampTime: 0.1,
      },
    });

    deliverUnicast({
      type: "SCHEDULED_ACTION",
      serverTimeToExecute: now,
      scheduledAction: { type: "METRONOME_CONFIG", enabled: this.isMetronomeEnabled },
    });

    deliverUnicast({
      type: "SCHEDULED_ACTION",
      serverTimeToExecute: now,
      scheduledAction: {
        type: "LOW_PASS_CONFIG",
        freq: this.lowPassFreq,
        rampTime: 0.05,
      },
    });

    if (this.playbackState.type === "playing" && this.playbackState.audioSource) {
      this.syncLateJoiner(peerId, deliverUnicast);
    }
  }

  private syncLateJoiner(peerId: string, deliverUnicast: (payload: P2PUnicastEnvelope["payload"]) => void): void {
    const startedAt = this.playbackState.serverTimeToExecute;
    const startedPos = this.playbackState.trackPositionSeconds;
    const executeAt = this.getScheduledExecutionTime({ extraOffsetMs: 1500 });
    const elapsedAtExecute = (executeAt - startedAt) / 1000;
    const resumePos = startedPos + elapsedAtExecute;

    deliverUnicast({
      type: "SCHEDULED_ACTION",
      serverTimeToExecute: executeAt,
      scheduledAction: {
        type: "PLAY",
        audioSource: this.playbackState.audioSource,
        trackTimeSeconds: resumePos,
      },
    });
  }

  private notifyLocalClientListChange(): void {
    this.callbacks.onLocalClientListChange(this.getActiveClients());
  }

  private broadcastAudioSources(): void {
    const currentAudioSource =
      this.playbackState.audioSource && this.audioSources.some((s) => s.url === this.playbackState.audioSource)
        ? this.playbackState.audioSource
        : undefined;

    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "ROOM_EVENT",
        event: {
          type: "SET_AUDIO_SOURCES",
          sources: this.audioSources,
          currentAudioSource,
        },
      },
    });
  }

  private broadcastPlaylists(): void {
    this.callbacks.broadcast({
      kind: "broadcast",
      payload: { type: "ROOM_EVENT", event: { type: "SET_PLAYLISTS", playlists: this.playlists } },
    });
  }

  private broadcastShuffle(): void {
    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "ROOM_EVENT",
        event: { type: "SET_SHUFFLE", enabled: this.isShuffled, shuffleHistory: this.shuffleHistory },
      },
    });
  }

  private libraryTracks(): Map<string, AudioSourceType> {
    return new Map(
      [...this.playlists.flatMap((playlist) => playlist.tracks), ...this.audioSources].map((track) => [
        track.url,
        track,
      ])
    );
  }

  private mutateLibrary(
    payload: Extract<
      WSRequestType,
      {
        type:
          | "CREATE_PLAYLIST"
          | "UPDATE_PLAYLIST"
          | "SET_PLAYLIST_TRACKS"
          | "DELETE_PLAYLIST"
          | "QUEUE_PLAYLIST"
          | "QUEUE_TRACKS"
          | "SET_DEFAULT_PLAYLIST";
      }
    >
  ): void {
    const tracksByUrl = this.libraryTracks();
    const resolveTracks = (urls: string[]) =>
      [...new Set(urls)].flatMap((url) => {
        const track = tracksByUrl.get(url);
        return track ? [track] : [];
      });
    const now = Date.now();
    const playlist =
      "playlistId" in payload ? this.playlists.find((item) => item.id === payload.playlistId) : undefined;
    switch (payload.type) {
      case "CREATE_PLAYLIST": {
        const id = payload.playlistId ?? crypto.randomUUID();
        if (this.playlists.some((item) => item.id === id)) return;
        const tracks = resolveTracks(payload.trackUrls ?? []);
        this.playlists.push({
          id,
          name: payload.name,
          tracks,
          trackUrls: tracks.map((track) => track.url),
          sourceKind: "manual",
          isSaved: false,
          isDefault: false,
          createdAt: now,
          updatedAt: now,
        });
        break;
      }
      case "UPDATE_PLAYLIST":
        if (!playlist) return;
        if (payload.name) playlist.name = payload.name;
        if (payload.artworkUrl !== undefined) playlist.artworkUrl = payload.artworkUrl ?? undefined;
        playlist.updatedAt = now;
        break;
      case "SET_PLAYLIST_TRACKS":
        if (!playlist) return;
        playlist.tracks = resolveTracks(payload.trackUrls);
        playlist.trackUrls = playlist.tracks.map((track) => track.url);
        playlist.updatedAt = now;
        break;
      case "DELETE_PLAYLIST":
        this.playlists = this.playlists.filter((item) => item.id !== payload.playlistId);
        break;
      case "SET_DEFAULT_PLAYLIST":
        if (!playlist) return;
        this.playlists.forEach((item) => {
          item.isDefault = item.id === playlist.id;
        });
        break;
      case "QUEUE_PLAYLIST":
      case "QUEUE_TRACKS": {
        const tracks = payload.type === "QUEUE_TRACKS" ? resolveTracks(payload.urls) : (playlist?.tracks ?? []);
        const queued = new Set(this.audioSources.map((source) => source.url));
        this.audioSources.push(...tracks.filter((track) => !queued.has(track.url)));
        this.broadcastAudioSources();
        break;
      }
    }
    this.broadcastPlaylists();
    this.persistCache();
  }

  private registerAudioSource(source: AudioSourceType): void {
    if (!isP2PTrackUrl(source.url)) return;
    if (this.audioSources.some((s) => s.url === source.url)) return;
    this.audioSources.push(source);
    this.broadcastAudioSources();
    this.persistCache();
  }

  private deleteAudioSources(urls: string[]): void {
    const toDelete = new Set(urls);
    if (toDelete.has(this.playbackState.audioSource)) {
      this.handlePause({ type: "PAUSE", audioSource: this.playbackState.audioSource, trackTimeSeconds: 0 });
    }
    this.audioSources = this.audioSources.filter((s) => !toDelete.has(s.url));
    this.broadcastAudioSources();
    this.persistCache();
  }

  private reorderAudioSources(sources: AudioSourceType[]): void {
    const byUrl = new Map(this.audioSources.map((source) => [source.url, source]));
    const urls = [...new Set(sources.map((source) => source.url))];
    if (urls.length !== byUrl.size || urls.some((url) => !byUrl.has(url))) return;
    this.audioSources = urls.map((url) => byUrl.get(url)!);
    this.broadcastAudioSources();
  }

  private handleChat(clientId: string, text: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    try {
      const message = this.chatManager.addMessage({ client, text });
      this.callbacks.broadcast({
        kind: "broadcast",
        payload: {
          type: "ROOM_EVENT",
          event: {
            type: "CHAT_UPDATE",
            messages: [message],
            isFullSync: false,
            newestId: this.chatManager.getNewestId(),
          },
        },
      });
    } catch (e) {
      console.error("[P2P host] chat error", e);
    }
  }

  private handlePlay(initiatorClientId: string, playAction: PlayActionType): void {
    const audioSource = this.audioSources.find((s) => s.url === playAction.audioSource);
    if (!audioSource) return;

    this.clearPendingPlay();
    const timeout = setTimeout(() => this.executeScheduledPlay(), AUDIO_LOAD_TIMEOUT_MS);
    this.pendingPlay = {
      clientsLoaded: new Set(),
      timeout,
      playAction,
    };

    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "ROOM_EVENT",
        event: { type: "LOAD_AUDIO_SOURCE", audioSourceToPlay: audioSource },
      },
    });
  }

  private handlePause(pauseAction: PauseActionType): void {
    this.clearPendingPlay();
    const executeAt = this.getScheduledExecutionTime();
    this.playbackState = {
      type: "paused",
      audioSource: pauseAction.audioSource,
      trackPositionSeconds: pauseAction.trackTimeSeconds,
      serverTimeToExecute: executeAt,
    };

    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "SCHEDULED_ACTION",
        serverTimeToExecute: executeAt,
        scheduledAction: pauseAction,
      },
    });
  }

  private handleAudioSourceLoaded(clientId: string, url: string): void {
    if (!this.pendingPlay || this.pendingPlay.playAction.audioSource !== url) return;
    this.pendingPlay.clientsLoaded.add(clientId);
    const total = this.getActiveClients().length;
    if (total > 0 && this.pendingPlay.clientsLoaded.size >= total) {
      this.executeScheduledPlay();
    }
  }

  private clearPendingPlay(): void {
    if (this.pendingPlay?.timeout) clearTimeout(this.pendingPlay.timeout);
    this.pendingPlay = undefined;
  }

  private executeScheduledPlay(): void {
    if (!this.pendingPlay) return;
    const { playAction } = this.pendingPlay;
    this.clearPendingPlay();

    const executeAt = this.getScheduledExecutionTime();
    const exists = this.audioSources.some((s) => s.url === playAction.audioSource);
    if (!exists) return;

    this.playbackState = {
      type: "playing",
      audioSource: playAction.audioSource,
      trackPositionSeconds: playAction.trackTimeSeconds,
      serverTimeToExecute: executeAt,
    };

    this.persistCache();
    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "SCHEDULED_ACTION",
        serverTimeToExecute: executeAt,
        scheduledAction: playAction,
      },
    });
  }

  private setGlobalVolume(volume: number): void {
    this.globalVolume = Math.max(0, Math.min(1, volume));
    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "SCHEDULED_ACTION",
        serverTimeToExecute: epochNow(),
        scheduledAction: {
          type: "GLOBAL_VOLUME_CONFIG",
          volume: this.globalVolume,
          rampTime: 0.1,
        },
      },
    });
  }

  private setLowPassFreq(freq: number): void {
    this.lowPassFreq = Math.max(LOW_PASS_CONSTANTS.MIN_FREQ, Math.min(LOW_PASS_CONSTANTS.MAX_FREQ, freq));
    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "SCHEDULED_ACTION",
        serverTimeToExecute: epochNow(),
        scheduledAction: {
          type: "LOW_PASS_CONFIG",
          freq: this.lowPassFreq,
          rampTime: 0.05,
        },
      },
    });
  }

  private setMetronome(enabled: boolean): void {
    this.isMetronomeEnabled = enabled;
    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "SCHEDULED_ACTION",
        serverTimeToExecute: epochNow(),
        scheduledAction: { type: "METRONOME_CONFIG", enabled },
      },
    });
  }

  private setPlaybackControls(permissions: PlaybackControlsPermissionsType): void {
    this.playbackControlsPermissions = coerceP2PPlaybackPermissions(permissions);
    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "ROOM_EVENT",
        event: { type: "SET_PLAYBACK_CONTROLS", permissions },
      },
    });
  }

  private setAdmin(targetClientId: string, isAdmin: boolean): void {
    const client = this.clients.get(targetClientId);
    if (!client) return;
    if (!isAdmin && this.peerIdByClientId.get(targetClientId) === this.authorityPeerId) return;
    client.isAdmin = isAdmin;
    this.clients.set(targetClientId, client);
    this.notifyLocalClientListChange();
  }

  private moveClient(clientId: string, position: PositionType): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    client.position = position;
    this.clients.set(clientId, client);
    this.broadcastSpatialConfig();
  }

  private updateListeningSource(position: PositionType): void {
    this.listeningSource = position;
    this.broadcastSpatialConfig();
  }

  private reorderClient(clientId: string): void {
    const list = this.getActiveClients();
    const idx = list.findIndex((c) => c.clientId === clientId);
    if (idx <= 0) return;
    const [client] = list.splice(idx, 1);
    list.unshift(client);
    this.clients.clear();
    list.forEach((c) => this.clients.set(c.clientId, c));
    positionClientsInCircle(list);
    this.broadcastSpatialConfig();
    this.notifyLocalClientListChange();
  }

  private startSpatialAudio(): void {
    if (this.spatialIntervalId) return;
    let loopCount = 0;
    this.spatialIntervalId = setInterval(() => {
      const clients = this.getActiveClients();
      if (clients.length === 0) return;

      const angle = (loopCount * Math.PI) / 30;
      this.listeningSource = {
        x: GRID.ORIGIN_X + GRID.CLIENT_RADIUS * Math.cos(angle),
        y: GRID.ORIGIN_Y + GRID.CLIENT_RADIUS * Math.sin(angle),
      };
      this.broadcastSpatialConfig();
      loopCount++;
    }, 100);
  }

  private stopSpatialAudio(): void {
    if (this.spatialIntervalId) {
      clearInterval(this.spatialIntervalId);
      this.spatialIntervalId = undefined;
    }
    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "SCHEDULED_ACTION",
        serverTimeToExecute: epochNow(),
        scheduledAction: { type: "STOP_SPATIAL_AUDIO" },
      },
    });
  }

  private broadcastSpatialConfig(): void {
    const clients = this.getActiveClients();
    if (clients.length === 0) return;

    const gains = Object.fromEntries(
      clients.map((client) => [
        client.clientId,
        {
          gain: calculateGainFromDistanceToSource({
            client: client.position,
            source: this.listeningSource,
          }),
          rampTime: 0.25,
        },
      ])
    );

    this.callbacks.broadcast({
      kind: "broadcast",
      payload: {
        type: "SCHEDULED_ACTION",
        serverTimeToExecute: this.getScheduledExecutionTime(),
        scheduledAction: {
          type: "SPATIAL_CONFIG",
          listeningSource: this.listeningSource,
          gains,
        },
      },
    });
  }

  destroy(): void {
    this.clearPendingPlay();
    this.stopSpatialAudio();
  }
}
