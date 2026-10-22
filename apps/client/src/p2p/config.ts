import { TRYSTERO_APP_ID } from "./constants";
import { getLocalPeerConnection } from "./localNetwork";

let config:
  | {
      appId: string;
      maxReceiveBytes: number;
      relayConfig: { urls: string[] };
      rtcConfig: RTCConfiguration;
      rtcPolyfill: typeof RTCPeerConnection;
    }
  | undefined;

export function getTrysteroConfig() {
  return (config ??= {
    appId: TRYSTERO_APP_ID,
    maxReceiveBytes: 128 * 1024 * 1024,
    relayConfig: { urls: ["wss://nos.lol", "wss://nostr.oxtr.dev", "wss://relay.primal.net"] },
    rtcConfig: { iceServers: [], iceCandidatePoolSize: 0 },
    rtcPolyfill: getLocalPeerConnection(),
  });
}
