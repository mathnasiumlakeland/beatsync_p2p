import { expect, test } from "bun:test";
import { requestLocalAddressAccess } from "../localAddressAccess";

test("compatibility permission stops every track before returning and never requests video", async () => {
  const stopped: number[] = [];
  const tracks = [0, 1].map((id) => ({ enabled: true, stop: () => stopped.push(id) }));
  let constraints: MediaStreamConstraints | undefined;
  await requestLocalAddressAccess({
    getUserMedia: async (value) => {
      constraints = value;
      return { getTracks: () => tracks } as unknown as MediaStream;
    },
  });
  expect(constraints).toEqual({ audio: true, video: false });
  expect(stopped).toEqual([0, 1]);
  expect(tracks.every((track) => !track.enabled)).toBe(true);
});

test("denied permission rejects instead of pretending the retry is ready", async () => {
  const denied = new DOMException("Denied", "NotAllowedError");
  await expect(
    requestLocalAddressAccess({
      getUserMedia: async () => {
        throw denied;
      },
    })
  ).rejects.toBe(denied);
});

test("unsupported capture reports a failure without starting a retry", async () => {
  await expect(requestLocalAddressAccess(undefined)).rejects.toThrow("unavailable");
});
