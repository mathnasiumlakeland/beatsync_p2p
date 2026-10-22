import { WSRequestSchema, type WSRequestType } from "@beatsync/shared";

/**
 * Compatibility boundary for the original BeatSync frontend. Its socket-shaped
 * interface sends the unchanged action protocol to the elected browser host.
 * This does not open a WebSocket or send audio to a server.
 */
export function createPeerUITransport(sendRequest: (request: WSRequestType) => void): WebSocket {
  const transport = {
    readyState: 1,
    url: "p2p://local-room",
    bufferedAmount: 0,
    send(data: string) {
      sendRequest(WSRequestSchema.parse(JSON.parse(data)));
    },
    close() {
      transport.readyState = 3;
    },
  };
  return transport as unknown as WebSocket;
}
