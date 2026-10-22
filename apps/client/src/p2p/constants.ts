import { validateFullRoomId } from "@/lib/room";

/** Trystero appId — must be unique across the Trystero network. */
export const TRYSTERO_APP_ID = "pro.mathnasium.javier.local-audio";

/** One room per local network. No room codes or passwords at entry. */
export const SINGLE_ROOM_ID = "123456";

/** Protocol segment in room id; bump when wire protocol breaks compat. */
export const TRYSTERO_PROTOCOL_VERSION = "v3";

const ROOM_ID_PATTERN = /^pro\.mathnasium\.javier\.local-audio-v\d+-(\d{6})$/;

/**
 * Maps UI room code (6 digits) → Trystero room id.
 * @example toTrysteroRoomId("482910") → "beatsync-p2p-v1-482910"
 */
export function toTrysteroRoomId(roomCode: string): string {
  if (!validateFullRoomId(roomCode)) {
    throw new Error(`Invalid room code: ${roomCode}`);
  }
  return `${TRYSTERO_APP_ID}-${TRYSTERO_PROTOCOL_VERSION}-${roomCode}`;
}

/** Extract 6-digit room code from a Trystero room id, or null if invalid. */
export function parseRoomCodeFromTrysteroRoomId(trysteroRoomId: string): string | null {
  const match = ROOM_ID_PATTERN.exec(trysteroRoomId);
  return match?.[1] ?? null;
}
