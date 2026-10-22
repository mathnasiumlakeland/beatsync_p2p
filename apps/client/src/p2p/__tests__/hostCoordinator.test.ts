import { describe, expect, test } from "bun:test";
import { P2PRoomCoordinator } from "../host/P2PRoomCoordinator";
import type { P2PRequestEnvelope, WSRequestType, WSResponseType } from "@beatsync/shared";
function fixture() {
  const messages: WSResponseType[] = [];
  const room = new P2PRoomCoordinator("123456", {
    getSelfPeerId: () => "host",
    getConnectedPeerIds: () => ["host", "listener"],
    onLocalClientListChange: () => {},
    broadcast: (e) => messages.push(e.payload),
    unicast: (e) => messages.push(e.payload),
    direct: (e) => messages.push(e.payload),
    stateSnapshot: () => {},
  });
  room.registerSelf({ peerId: "host", clientId: "host-client", username: "Host", isAdmin: true });
  room.registerPeer({
    peerId: "listener",
    clientId: "listener-client",
    username: "Listener",
    isCreator: false,
    isAdmin: false,
  });
  room.setAuthority("host");
  const request = (payload: WSRequestType, peer = "host"): P2PRequestEnvelope => ({
    kind: "request",
    fromPeerId: peer,
    clientId: `${peer}-client`,
    username: peer,
    payload,
  });
  return { room, messages, request };
}
describe("single authoritative playback coordinator", () => {
  test("explicitly demoted listeners cannot mutate an admin-only room", async () => {
    const { room, request, messages } = fixture();
    try {
      await room.handleInitiatorRequest(request({ type: "SET_ADMIN", clientId: "listener-client", isAdmin: false }));
      await room.handleInitiatorRequest(request({ type: "SET_PLAYBACK_CONTROLS", permissions: "ADMIN_ONLY" }));
      messages.length = 0;
      await room.handleInitiatorRequest(
        request({ type: "REGISTER_AUDIO_SOURCE", source: { url: "p2p://one", name: "One.mp3" } }, "listener")
      );
      await room.handleInitiatorRequest(request({ type: "SET_GLOBAL_VOLUME", volume: 0.1 }, "listener"));
      expect(room.exportSnapshot().audioSources).toEqual([]);
      expect(room.exportSnapshot().globalVolume).toBe(0.5);
      expect(messages).toHaveLength(0);
    } finally {
      room.destroy();
    }
  });
  test("reordering preserves filenames and rejects injected queue entries", async () => {
    const { room, request } = fixture();
    try {
      for (const id of ["one", "two"])
        await room.handleInitiatorRequest(
          request({ type: "REGISTER_AUDIO_SOURCE", source: { url: `p2p://${id}`, name: `${id}.mp3` } })
        );
      await room.handleInitiatorRequest(
        request({ type: "REORDER_AUDIO_SOURCES", reorderedAudioSources: [{ url: "p2p://two" }, { url: "p2p://one" }] })
      );
      expect(room.exportSnapshot().audioSources.map((s) => s.name)).toEqual(["two.mp3", "one.mp3"]);
      await room.handleInitiatorRequest(
        request({ type: "REORDER_AUDIO_SOURCES", reorderedAudioSources: [{ url: "https://other.example/audio" }] })
      );
      expect(room.exportSnapshot().audioSources).toHaveLength(2);
    } finally {
      room.destroy();
    }
  });
  test("prefetched audio cannot prematurely release a different track's playback barrier", async () => {
    const { room, request, messages } = fixture();
    try {
      await room.handleInitiatorRequest(
        request({ type: "REGISTER_AUDIO_SOURCE", source: { url: "p2p://one", name: "One.mp3" } })
      );
      await room.handleInitiatorRequest(request({ type: "PLAY", audioSource: "p2p://one", trackTimeSeconds: 0 }));
      room.handleRemoteAudioLoaded("host-client", "p2p://two");
      room.handleRemoteAudioLoaded("listener-client", "p2p://one");
      expect(messages.some((m) => m.type === "SCHEDULED_ACTION" && m.scheduledAction.type === "PLAY")).toBe(false);
      room.handleRemoteAudioLoaded("host-client", "p2p://one");
      expect(messages.filter((m) => m.type === "SCHEDULED_ACTION" && m.scheduledAction.type === "PLAY")).toHaveLength(
        1
      );
    } finally {
      room.destroy();
    }
  });
  test("pause cancels an unfinished play request", async () => {
    const { room, request, messages } = fixture();
    try {
      await room.handleInitiatorRequest(request({ type: "REGISTER_AUDIO_SOURCE", source: { url: "p2p://one" } }));
      await room.handleInitiatorRequest(request({ type: "PLAY", audioSource: "p2p://one", trackTimeSeconds: 0 }));
      await room.handleInitiatorRequest(request({ type: "PAUSE", audioSource: "p2p://one", trackTimeSeconds: 0 }));
      room.handleRemoteAudioLoaded("host-client", "p2p://one");
      room.handleRemoteAudioLoaded("listener-client", "p2p://one");
      expect(messages.some((m) => m.type === "SCHEDULED_ACTION" && m.scheduledAction.type === "PLAY")).toBe(false);
    } finally {
      room.destroy();
    }
  });
});

describe("host state replication", () => {
  test("handover preserves a queue added after the listener joined", () => {
    const { room } = fixture();
    try {
      room.applyHostMessage({
        type: "ROOM_EVENT",
        event: { type: "SET_AUDIO_SOURCES", sources: [{ url: "p2p://fresh", name: "New song.mp3" }] },
      });
      room.applyHostMessage({
        type: "SCHEDULED_ACTION",
        serverTimeToExecute: 123,
        scheduledAction: { type: "PLAY", audioSource: "p2p://fresh", trackTimeSeconds: 8 },
      });
      room.applyHostMessage({
        type: "SCHEDULED_ACTION",
        serverTimeToExecute: 123,
        scheduledAction: { type: "GLOBAL_VOLUME_CONFIG", volume: 0.6, rampTime: 0.1 },
      });
      room.resetPlaybackForHostChange(11);
      room.setAuthority("listener");
      const snapshot = room.exportSnapshot();
      expect(snapshot.audioSources).toEqual([{ url: "p2p://fresh", name: "New song.mp3" }]);
      expect(snapshot.playbackState).toMatchObject({
        type: "paused",
        audioSource: "p2p://fresh",
        trackPositionSeconds: 11,
      });
      expect(snapshot.globalVolume).toBe(0.6);
      expect(
        room
          .getActiveClients()
          .filter((c) => c.isAdmin)
          .map((c) => c.clientId)
      ).toEqual(["host-client", "listener-client"]);
    } finally {
      room.destroy();
    }
  });
  test("empty host queues explicitly clear stale listener queues", () => {
    const { room, messages } = fixture();
    try {
      room.hydrateLocalConsumer((message) => messages.push(message));
      expect(
        messages.some(
          (message) =>
            message.type === "ROOM_EVENT" &&
            message.event.type === "SET_AUDIO_SOURCES" &&
            message.event.sources.length === 0
        )
      ).toBe(true);
    } finally {
      room.destroy();
    }
  });
  test("the static queue accepts only local peer files", async () => {
    const { room, request } = fixture();
    try {
      await room.handleInitiatorRequest(
        request({ type: "REGISTER_AUDIO_SOURCE", source: { url: "https://other.example/audio.mp3" } })
      );
      await room.handleInitiatorRequest(
        request({ type: "REGISTER_AUDIO_SOURCE", source: { url: "p2p://../invalid" } })
      );
      expect(room.exportSnapshot().audioSources).toEqual([]);
    } finally {
      room.destroy();
    }
  });
});

test("roster registration preserves the prior cache and all host mutations persist", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
    configurable: true,
  });
  let room: P2PRoomCoordinator | undefined;
  try {
    const cached = {
      version: 1,
      updatedAt: 1,
      audioSources: [{ url: "p2p://saved", name: "Saved.mp3" }],
      playbackState: { type: "paused" as const, audioSource: "", serverTimeToExecute: 0, trackPositionSeconds: 0 },
      playbackControlsPermissions: "ADMIN_ONLY" as const,
      globalVolume: 1,
      lowPassFreq: 20000,
      isMetronomeEnabled: false,
      chatMessages: [],
      chatNextMessageId: 1,
    };
    values.set("beatsync-p2p-room-123456", JSON.stringify(cached));
    const fixtureState = fixture();
    room = fixtureState.room;
    expect(JSON.parse(values.get("beatsync-p2p-room-123456")!).audioSources).toEqual(cached.audioSources);
    room.applySnapshot(cached);
    expect(JSON.parse(values.get("beatsync-p2p-room-123456")!).audioSources).toEqual(cached.audioSources);
    room.applySnapshot({ ...cached, audioSources: [] });
    expect(JSON.parse(values.get("beatsync-p2p-room-123456")!).audioSources).toEqual([]);
    await room.handleInitiatorRequest(fixtureState.request({ type: "SET_PLAYBACK_CONTROLS", permissions: "EVERYONE" }));
    await room.handleInitiatorRequest(fixtureState.request({ type: "SET_GLOBAL_VOLUME", volume: 0.25 }));
    await room.handleInitiatorRequest(fixtureState.request({ type: "SET_METRONOME", enabled: true }));
    expect(JSON.parse(values.get("beatsync-p2p-room-123456")!)).toMatchObject({
      playbackControlsPermissions: "EVERYONE",
      globalVolume: 0.25,
      isMetronomeEnabled: true,
    });
    room.resetPlaybackForHostChange(12);
    expect(JSON.parse(values.get("beatsync-p2p-room-123456")!).playbackState).toMatchObject({
      type: "paused",
      trackPositionSeconds: 12,
    });
  } finally {
    room?.destroy();
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("original BeatSync library and permissions", () => {
  test("manual playlists survive queue clearing, editing, and snapshot handover", async () => {
    const { room, request } = fixture();
    const replica = fixture().room;
    try {
      for (const id of ["one", "two"])
        await room.handleInitiatorRequest(
          request({
            type: "REGISTER_AUDIO_SOURCE",
            source: {
              url: `p2p://${id}`,
              title: id,
              metadata: { durationSeconds: 60 },
            },
          })
        );
      await room.handleInitiatorRequest(
        request({
          type: "CREATE_PLAYLIST",
          playlistId: "favorites",
          name: "Favorites",
          trackUrls: ["p2p://two", "p2p://one", "p2p://unavailable"],
        })
      );
      await room.handleInitiatorRequest(request({ type: "SET_DEFAULT_PLAYLIST", playlistId: "favorites" }));
      await room.handleInitiatorRequest(request({ type: "CLEAR_AUDIO_QUEUE" }));
      expect(room.exportSnapshot().audioSources).toEqual([]);
      expect(room.exportSnapshot().playlists?.[0].trackUrls).toEqual(["p2p://two", "p2p://one"]);

      replica.applySnapshot(room.exportSnapshot());
      await replica.handleInitiatorRequest(request({ type: "LOAD_DEFAULT_TRACKS" }));
      expect(replica.exportSnapshot().audioSources.map((track) => track.url)).toEqual(["p2p://two", "p2p://one"]);
      expect(replica.exportSnapshot().audioSources[0].metadata?.durationSeconds).toBe(60);
      await replica.handleInitiatorRequest(
        request({ type: "UPDATE_PLAYLIST", playlistId: "favorites", name: "Room favorites" })
      );
      await replica.handleInitiatorRequest(
        request({ type: "SET_PLAYLIST_TRACKS", playlistId: "favorites", trackUrls: ["p2p://one"] })
      );
      expect(replica.exportSnapshot().playlists?.[0]).toMatchObject({
        name: "Room favorites",
        trackUrls: ["p2p://one"],
      });
      await replica.handleInitiatorRequest(request({ type: "DELETE_PLAYLIST", playlistId: "favorites" }));
      expect(replica.exportSnapshot().playlists).toEqual([]);
      expect(replica.exportSnapshot().audioSources).toHaveLength(2);
    } finally {
      room.destroy();
      replica.destroy();
    }
  });

  test("everyone mode lets a listener add and play audio through the host", async () => {
    const { room, request, messages } = fixture();
    try {
      await room.handleInitiatorRequest(request({ type: "SET_PLAYBACK_CONTROLS", permissions: "EVERYONE" }));
      await room.handleInitiatorRequest(
        request({ type: "REGISTER_AUDIO_SOURCE", source: { url: "p2p://guest", title: "Guest track" } }, "listener")
      );
      await room.handleInitiatorRequest(
        request({ type: "PLAY", audioSource: "p2p://guest", trackTimeSeconds: 3 }, "listener")
      );
      room.handleRemoteAudioLoaded("host-client", "p2p://guest");
      room.handleRemoteAudioLoaded("listener-client", "p2p://guest");
      expect(room.exportSnapshot().playbackControlsPermissions).toBe("EVERYONE");
      expect(
        messages.some(
          (message) =>
            message.type === "SCHEDULED_ACTION" &&
            message.scheduledAction.type === "PLAY" &&
            message.scheduledAction.trackTimeSeconds === 3
        )
      ).toBe(true);
    } finally {
      room.destroy();
    }
  });

  test("explicit admin demotion is respected and promotion survives presence updates", async () => {
    const { room, request } = fixture();
    try {
      await room.handleInitiatorRequest(request({ type: "SET_ADMIN", clientId: "listener-client", isAdmin: false }));
      await room.handleInitiatorRequest(
        request({ type: "SET_ADMIN", clientId: "listener-client", isAdmin: true }, "listener")
      );
      expect(room.getActiveClients().find((client) => client.clientId === "listener-client")?.isAdmin).toBe(false);
      await room.handleInitiatorRequest(request({ type: "SET_ADMIN", clientId: "listener-client", isAdmin: true }));
      room.setAuthority("host");
      expect(room.getActiveClients().find((client) => client.clientId === "listener-client")?.isAdmin).toBe(true);
      await room.handleInitiatorRequest(
        request({ type: "CREATE_PLAYLIST", name: "Guest set", trackUrls: [] }, "listener")
      );
      expect(room.exportSnapshot().playlists?.[0].name).toBe("Guest set");
    } finally {
      room.destroy();
    }
  });

  test("host replica retains library, permission and shuffle broadcasts", async () => {
    const { room, request } = fixture();
    const replica = fixture().room;
    try {
      await room.handleInitiatorRequest(request({ type: "CREATE_PLAYLIST", name: "Saved set", trackUrls: [] }));
      replica.applyHostMessage({
        type: "ROOM_EVENT",
        event: { type: "SET_PLAYLISTS", playlists: room.exportSnapshot().playlists! },
      });
      replica.applyHostMessage({
        type: "ROOM_EVENT",
        event: { type: "SET_PLAYBACK_CONTROLS", permissions: "EVERYONE" },
      });
      replica.applyHostMessage({
        type: "ROOM_EVENT",
        event: { type: "SET_SHUFFLE", enabled: true, shuffleHistory: ["p2p://one"] },
      });
      expect(replica.exportSnapshot()).toMatchObject({
        playlists: [{ name: "Saved set" }],
        playbackControlsPermissions: "EVERYONE",
        isShuffled: true,
        shuffleHistory: ["p2p://one"],
      });
    } finally {
      room.destroy();
      replica.destroy();
    }
  });
});

test("new participants are admins and can upload, play and change permissions without promotion", async () => {
  const { room, request, messages } = fixture();
  try {
    expect(room.exportSnapshot().playbackControlsPermissions).toBe("EVERYONE");
    expect(room.getActiveClients().every((client) => client.isAdmin)).toBe(true);
    await room.handleInitiatorRequest(
      request({ type: "SET_PLAYBACK_CONTROLS", permissions: "ADMIN_ONLY" }, "listener")
    );
    expect(room.exportSnapshot().playbackControlsPermissions).toBe("ADMIN_ONLY");
    await room.handleInitiatorRequest(
      request({ type: "REGISTER_AUDIO_SOURCE", source: { url: "p2p://shared", name: "Shared.mp3" } }, "listener")
    );
    await room.handleInitiatorRequest(
      request({ type: "PLAY", audioSource: "p2p://shared", trackTimeSeconds: 0 }, "listener")
    );
    room.handleRemoteAudioLoaded("host-client", "p2p://shared");
    room.handleRemoteAudioLoaded("listener-client", "p2p://shared");
    expect(
      messages.some((message) => message.type === "SCHEDULED_ACTION" && message.scheduledAction.type === "PLAY")
    ).toBe(true);
  } finally {
    room.destroy();
  }
});

test("old host-only caches upgrade once while later explicit permission choices persist", () => {
  const { room } = fixture();
  try {
    const snapshot = {
      ...room.exportSnapshot(),
      version: 1,
      playbackControlsPermissions: "ADMIN_ONLY" as const,
      audioSources: [{ url: "p2p://kept", name: "Keep me.mp3" }],
    };
    room.applySnapshot(snapshot);
    expect(room.exportSnapshot()).toMatchObject({
      version: 2,
      playbackControlsPermissions: "EVERYONE",
      audioSources: snapshot.audioSources,
    });
    room.applySnapshot({ ...snapshot, version: 2 });
    expect(room.exportSnapshot().playbackControlsPermissions).toBe("ADMIN_ONLY");
  } finally {
    room.destroy();
  }
});
