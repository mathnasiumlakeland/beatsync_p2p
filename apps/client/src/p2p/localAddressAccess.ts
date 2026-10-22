/** Call only from the explicitly labelled microphone compatibility action. */
export async function requestLocalAddressAccess(
  mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined
): Promise<void> {
  if (!mediaDevices?.getUserMedia) throw new Error("Microphone access is unavailable in this browser.");
  const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
  // Never attach this stream to WebRTC, Web Audio, a recorder, or storage.
  // The browser permission may expose private host ICE addresses on a retry.
  for (const track of stream.getTracks()) {
    track.enabled = false;
    track.stop();
  }
}
