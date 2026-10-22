"use client";

import { useClientId } from "@/hooks/useClientId";
import { useNtpHeartbeat } from "@/hooks/useNtpHeartbeat";
import { IS_DEMO_MODE } from "@/lib/demo";
import { dispatchRoomMessage } from "@/lib/roomMessages";
import { getTrysteroConfig } from "@/p2p/config";
import { toTrysteroRoomId } from "@/p2p/constants";
import { joinRoom } from "trystero";
import { toast } from "sonner";
import { useP2PConnectionStore } from "@/store/p2pConnection";
import { useChatStore } from "@/store/chat";
import { useGlobalStore } from "@/store/global";
import { useRoomStore } from "@/store/room";
import { toP2PTrackUrl } from "@/p2p/audio/urls";
import { getProbeStats, type NTPMeasurement } from "@/utils/ntp";
import { ClientActionEnum, WSResponseType } from "@beatsync/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LocalConnectionHelp } from "./LocalConnectionHelp";

interface TrysteroManagerProps {
  roomId: string;
  username: string;
}

export const TrysteroManager = ({ roomId, username }: TrysteroManagerProps) => {
  const { clientId } = useClientId();
  const [connectionHelpOpen, setConnectionHelpOpen] = useState(false);
  const peerCount = useP2PConnectionStore((state) => state.connectedPeerIds.length);
  useEffect(() => {
    if (peerCount > 1) toast.dismiss("local-peer-connection");
  }, [peerCount]);
  const isLoadingRoom = useRoomStore((state) => state.isLoadingRoom);

  const trysteroRoomId = toTrysteroRoomId(roomId);

  const addProbePairResult = useGlobalStore((state) => state.addProbePairResult);
  const setConnectedClients = useGlobalStore((state) => state.setConnectedClients);
  const schedulePlay = useGlobalStore((state) => state.schedulePlay);
  const schedulePause = useGlobalStore((state) => state.schedulePause);
  const processSpatialConfig = useGlobalStore((state) => state.processSpatialConfig);
  const setIsSpatialAudioEnabled = useGlobalStore((state) => state.setIsSpatialAudioEnabled);
  const processStopSpatialAudio = useGlobalStore((state) => state.processStopSpatialAudio);
  const processGlobalVolumeConfig = useGlobalStore((state) => state.processGlobalVolumeConfig);
  const processLowPassConfig = useGlobalStore((state) => state.processLowPassConfig);
  const processMetronomeConfig = useGlobalStore((state) => state.processMetronomeConfig);
  const handleSetAudioSources = useGlobalStore((state) => state.handleSetAudioSources);
  const setPlaybackControlsPermissions = useGlobalStore((state) => state.setPlaybackControlsPermissions);
  const setActiveStreamJobs = useGlobalStore((state) => state.setActiveStreamJobs);
  const setMessages = useChatStore((state) => state.setMessages);
  const handleLoadAudioSource = useGlobalStore((state) => state.handleLoadAudioSource);

  const attachSession = useP2PConnectionStore((state) => state.attachSession);
  const detachSession = useP2PConnectionStore((state) => state.detachSession);
  const setOnServerMessage = useP2PConnectionStore((state) => state.setOnServerMessage);
  const sendRequest = useP2PConnectionStore((state) => state.sendRequest);
  const isReady = useP2PConnectionStore((state) => state.isReady);

  const startHeartbeatRef = useRef<() => void>(() => {});
  const stopHeartbeatRef = useRef<() => void>(() => {});

  const { startHeartbeat, stopHeartbeat, markNTPResponseReceived } = useNtpHeartbeat({
    onConnectionStale: () => {
      console.warn("[P2P] NTP stale — resetting sync (staying in room)");
      useGlobalStore.getState().resetNTPConfig();
      startHeartbeatRef.current();
    },
  });

  startHeartbeatRef.current = startHeartbeat;
  stopHeartbeatRef.current = stopHeartbeat;

  const messageContext = useMemo(
    () => ({
      onNTPResponse: (pairResult: NTPMeasurement | null) => {
        if (pairResult) addProbePairResult(pairResult);
      },
      onNTPResponseReceived: markNTPResponseReceived,
      setProbeStats: () => useGlobalStore.setState({ probeStats: getProbeStats() }),
      setConnectedClients,
      handleSetAudioSources,
      syncPlaylists: (playlists: unknown) => useGlobalStore.getState().syncPlaylists(playlists),
      setShuffleEnabled: (enabled: boolean, history?: string[]) =>
        useGlobalStore.getState().setShuffleEnabled(enabled, history),
      setPlaybackControlsPermissions,
      setMessages,
      handleLoadAudioSource,
      schedulePlay,
      schedulePause,
      processSpatialConfig,
      setIsSpatialAudioEnabled,
      get isSpatialAudioEnabled() {
        return useGlobalStore.getState().isSpatialAudioEnabled;
      },
      processStopSpatialAudio,
      processGlobalVolumeConfig,
      processLowPassConfig,
      processMetronomeConfig,
      onSearchResponse: (response: Extract<WSResponseType, { type: "SEARCH_RESPONSE" }>) => {
        const { setSearchResults, setIsSearching, setIsLoadingMoreResults, setHasMoreResults, isLoadingMoreResults } =
          useGlobalStore.getState();
        setSearchResults(response.response, isLoadingMoreResults);
        setIsSearching(false);
        setIsLoadingMoreResults(false);
        if (response.response.type === "success") {
          const { total, items, offset } = response.response.response.data.tracks;
          setHasMoreResults(offset + items.length < total);
        } else {
          setHasMoreResults(false);
        }
      },
      setActiveStreamJobs,
      setDemoUserCount: (count: number) => useGlobalStore.setState({ demoUserCount: count }),
      setDemoAudioReadyCount: (count: number) => useGlobalStore.setState({ demoAudioReadyCount: count }),
    }),
    [
      addProbePairResult,
      markNTPResponseReceived,
      setConnectedClients,
      handleSetAudioSources,
      setPlaybackControlsPermissions,
      setMessages,
      handleLoadAudioSource,
      schedulePlay,
      schedulePause,
      processSpatialConfig,
      setIsSpatialAudioEnabled,
      processStopSpatialAudio,
      processGlobalVolumeConfig,
      processLowPassConfig,
      processMetronomeConfig,
      setActiveStreamJobs,
    ]
  );

  const onServerMessage = useCallback(
    (message: WSResponseType) => {
      useGlobalStore.setState({ lastMessageReceivedTime: Date.now() });
      dispatchRoomMessage(message, messageContext);
    },
    [messageContext]
  );

  useEffect(() => {
    setOnServerMessage(onServerMessage);
  }, [onServerMessage, setOnServerMessage]);

  const loggedRoomRef = useRef<string | null>(null);
  useEffect(() => {
    if (loggedRoomRef.current === trysteroRoomId) return;
    loggedRoomRef.current = trysteroRoomId;
    console.log(`[P2P] Joined Trystero room ${trysteroRoomId}`);
  }, [trysteroRoomId]);

  useEffect(() => {
    if (isLoadingRoom || !roomId || !username || !clientId) return;

    let activeRoom: ReturnType<typeof joinRoom>;
    let reportedConnectionFailure = false;
    try {
      activeRoom = joinRoom(getTrysteroConfig(), trysteroRoomId, {
        onJoinError: ({ error }) => {
          console.warn("[P2P] Local peer connection failed", error);
          if (useP2PConnectionStore.getState().connectedPeerIds.length > 1) return;
          const message = "Could not reach another device on the local network.";
          useP2PConnectionStore.setState({ connectionError: message });
          if (!reportedConnectionFailure) {
            reportedConnectionFailure = true;
            toast.error(message, {
              id: "local-peer-connection",
              description:
                "Use the same Wi-Fi, allow local network access for your browser, and check that the network allows devices to communicate.",
              duration: Infinity,
              action: { label: "Connection help", onClick: () => setConnectionHelpOpen(true) },
            });
          }
        },
      });
    } catch (error) {
      useP2PConnectionStore.setState({
        connectionError: `This browser could not start WebRTC. Try Chrome or allow peer connections. ${String(error)}`,
      });
      return;
    }

    attachSession({ room: activeRoom, roomCode: roomId, clientId, username });
    startHeartbeatRef.current();

    return () => {
      stopHeartbeatRef.current();
      useGlobalStore.getState().onConnectionReset();
      detachSession();
      void activeRoom.leave();
    };
  }, [isLoadingRoom, roomId, username, clientId, trysteroRoomId, attachSession, detachSession]);

  useEffect(() => {
    const onTrackReceived = (event: Event) => {
      const trackId = (event as CustomEvent<{ trackId: string }>).detail?.trackId;
      if (!trackId) return;
      const url = toP2PTrackUrl(trackId);
      const state = useGlobalStore.getState();
      const entry = state.audioSources.find((s) => s.source.url === url);
      if (entry && (entry.status === "idle" || entry.status === "error" || entry.status === "loading")) {
        state.preloadAudioSource(url);
      }
      // The original player retries its pending scheduled play after decoding.
      // A second SYNC here would stop that playback and schedule it again.
    };
    const onCacheUnavailable = () =>
      toast.info(
        "Browser storage is unavailable. Music will play for this session; keep a device with the original files connected.",
        { duration: 10000 }
      );
    window.addEventListener("p2p-track-received", onTrackReceived);
    window.addEventListener("p2p-audio-cache-unavailable", onCacheUnavailable);
    return () => {
      window.removeEventListener("p2p-track-received", onTrackReceived);
      window.removeEventListener("p2p-audio-cache-unavailable", onCacheUnavailable);
    };
  }, []);

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === "visible") {
        useGlobalStore.getState().resetNTPConfig();
        startHeartbeatRef.current();
        useP2PConnectionStore.getState().requestRoomSync();
      }
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, []);

  return <LocalConnectionHelp open={connectionHelpOpen} onOpenChange={setConnectionHelpOpen} />;
};
