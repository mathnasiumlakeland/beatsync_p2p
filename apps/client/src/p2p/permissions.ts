import { IS_P2P_MODE } from "@/lib/p2p";
import type { ClientDataType, PlaybackControlsPermissionsType } from "@beatsync/shared";
import { NTP_CONSTANTS, PlaybackControlsPermissionsEnum } from "@beatsync/shared";

export const P2P_DEFAULT_PLAYBACK_PERMISSIONS = PlaybackControlsPermissionsEnum.enum.EVERYONE;
export const P2P_NTP_MEASUREMENTS_REQUIRED = NTP_CONSTANTS.MAX_MEASUREMENTS;
export function isP2PEqualPeerMode(): boolean {
  return false;
}
export function coerceP2PPlaybackPermissions(
  permissions: PlaybackControlsPermissionsType
): PlaybackControlsPermissionsType {
  return permissions;
}
export function normalizeP2PClient(client: ClientDataType): ClientDataType {
  return client;
}
export function normalizeP2PClientRoster(clients: ClientDataType[]): ClientDataType[] {
  return clients;
}
export function getNtpMeasurementsRequired(): number {
  return IS_P2P_MODE ? P2P_NTP_MEASUREMENTS_REQUIRED : NTP_CONSTANTS.MAX_MEASUREMENTS;
}
