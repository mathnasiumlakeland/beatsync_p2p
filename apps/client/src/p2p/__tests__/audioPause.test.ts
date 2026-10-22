import { afterEach, describe, expect, mock, test } from "bun:test";
import { useGlobalStore } from "@/store/global";
import { useP2PConnectionStore } from "@/store/p2pConnection";

const initialState = useGlobalStore.getState();
const initialHost = useP2PConnectionStore.getState().isHost;
afterEach(() => {
  useGlobalStore.setState(initialState);
  useP2PConnectionStore.setState({ isHost: initialHost });
});

describe("pausing an idle original player", () => {
  test("clearing a queue before the first play never stops an unstarted source", () => {
    const stop = mock(() => {
      throw new DOMException("not started", "InvalidStateError");
    });
    useGlobalStore.setState({
      isPlaying: false,
      audioPlayer: {
        sourceNode: { stop } as unknown as AudioBufferSourceNode,
        audioContext: { currentTime: 12 } as AudioContext,
        gainNode: {} as GainNode,
      },
    });
    expect(() => useGlobalStore.getState().pauseAudio({ when: 0 })).not.toThrow();
    expect(stop).not.toHaveBeenCalled();
  });

  test("an intentional pause cannot trigger track-end autoplay", () => {
    const stop = mock(() => {});
    const sourceNode = { stop, onended: () => {} } as unknown as AudioBufferSourceNode;
    useGlobalStore.setState({
      isPlaying: true,
      playbackOffset: 3,
      playbackStartTime: 10,
      audioPlayer: {
        sourceNode,
        audioContext: { currentTime: 12 } as AudioContext,
        gainNode: {} as GainNode,
      },
    });
    useGlobalStore.getState().pauseAudio({ when: 0.5 });
    expect(sourceNode.onended).toBeNull();
    expect(stop).toHaveBeenCalledWith(12.5);
    expect(useGlobalStore.getState().currentTime).toBe(5.5);
    expect(useGlobalStore.getState().isPlaying).toBe(false);
  });
});

describe("natural playback completion", () => {
  test.each([1, 2])("the host publishes a pause when a %i-track scoped queue finishes", (count) => {
    const broadcastPause = mock(() => {});
    const urls = ["p2p://one", "p2p://two"].slice(0, count);
    useP2PConnectionStore.setState({ isHost: true });
    useGlobalStore.setState({
      audioSources: urls.map((url) => ({ source: { url }, status: "idle" })),
      selectedAudioUrl: urls.at(-1)!,
      playbackContext: { scope: "all-tracks", urls },
      isPlaying: true,
      duration: 60,
      broadcastPause,
    });
    useGlobalStore.getState().skipToNextTrack(true);
    expect(broadcastPause).toHaveBeenCalledTimes(1);
    expect(useGlobalStore.getState().isPlaying).toBe(false);
    expect(useGlobalStore.getState().currentTime).toBe(60);
  });

  test("a listener finishing its buffer does not pause the room", () => {
    const broadcastPause = mock(() => {});
    useP2PConnectionStore.setState({ isHost: false });
    useGlobalStore.setState({ isPlaying: true, duration: 60, broadcastPause });
    useGlobalStore.getState().skipToNextTrack(true);
    expect(broadcastPause).not.toHaveBeenCalled();
    expect(useGlobalStore.getState().isPlaying).toBe(false);
  });
});
