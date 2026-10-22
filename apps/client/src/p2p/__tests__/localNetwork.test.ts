import { describe, expect, test } from "bun:test";
import { isLocalAddress, isLocalCandidate, localOnlySdp } from "../localNetwork";
const candidate = (address: string, type = "host") => `candidate:1 1 udp 2122260223 ${address} 50000 typ ${type}`;

describe("local network transport boundary", () => {
  test("accepts RFC1918, link local, loopback and mDNS addresses", () => {
    for (const address of [
      "192.168.1.10",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.1.1",
      "127.0.0.1",
      "::1",
      "fd12:abcd::1",
      "fc00::1",
      "fe80::1",
      "abcd-1234.local",
      "::ffff:192.168.0.2",
    ]) {
      expect(isLocalAddress(address)).toBe(true);
      expect(isLocalCandidate(candidate(address))).toBe(true);
    }
  });
  test("rejects public IPv4, global IPv6, DNS and malformed addresses", () => {
    for (const address of [
      "8.8.8.8",
      "100.64.0.1",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.1.1",
      "2001:db8::1",
      "::ffff:8.8.8.8",
      "not.local.evil.com",
      "192.168.1.999",
      "10.1.2",
      "",
    ]) {
      expect(isLocalAddress(address)).toBe(false);
      expect(isLocalCandidate(candidate(address))).toBe(false);
    }
  });
  test("rejects STUN/TURN and peer reflexive candidates even if private", () => {
    for (const type of ["srflx", "relay", "prflx"]) expect(isLocalCandidate(candidate("10.0.0.1", type))).toBe(false);
  });
  test("filters SDP while preserving the local ICE handshake", () => {
    const sdp = [
      "v=0",
      "a=ice-ufrag:example",
      `a=${candidate("192.168.1.2")}`,
      `a=${candidate("203.0.113.2")}`,
      `a=${candidate("192.168.1.3", "relay")}`,
      "a=end-of-candidates",
      "",
    ].join("\r\n");
    const filtered = localOnlySdp(sdp);
    expect(filtered).toContain("a=ice-ufrag:example");
    expect(filtered).toContain("192.168.1.2");
    expect(filtered).not.toContain("203.0.113.2");
    expect(filtered).not.toContain("typ relay");
    expect(filtered).toEndWith("\r\n");
  });
});
