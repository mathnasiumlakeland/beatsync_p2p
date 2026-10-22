/** Browsers cannot read an SSID. Limit ICE to addresses reachable on a local link. */
export function isLocalAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^[a-z0-9-]+\.local\.?$/.test(address)) return true;
  if (address === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(address) || /^fe[89ab][0-9a-f]:/.test(address)) return true;
  if (address.startsWith("::ffff:")) return isLocalAddress(address.slice(7));
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return (
    a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
  );
}

export function isLocalCandidate(candidate: string): boolean {
  const fields = candidate.replace(/^a=/, "").trim().split(/\s+/);
  return (
    /^candidate:/.test(fields[0] ?? "") &&
    fields[6] === "typ" &&
    fields[7] === "host" &&
    isLocalAddress(fields[4] ?? "")
  );
}

export function localOnlySdp(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("a=candidate:") || isLocalCandidate(line))
    .join("\r\n");
}

let localConnectionClass: typeof RTCPeerConnection | undefined;

/** The filter applies to SDP AND trickled candidates in both directions. */
export function getLocalPeerConnection(): typeof RTCPeerConnection {
  if (localConnectionClass) return localConnectionClass;
  class LocalPeerConnection extends RTCPeerConnection {
    constructor(config?: RTCConfiguration) {
      super({ ...config, iceServers: [], iceCandidatePoolSize: 0 });
      this.addEventListener("icecandidate", (event) => {
        if (event.candidate && !isLocalCandidate(event.candidate.candidate)) event.stopImmediatePropagation();
      });
    }

    override get localDescription(): RTCSessionDescription | null {
      const description = super.localDescription;
      return description
        ? new RTCSessionDescription({ type: description.type, sdp: localOnlySdp(description.sdp) })
        : null;
    }

    override setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
      return super.setRemoteDescription({
        ...description,
        sdp: description.sdp ? localOnlySdp(description.sdp) : undefined,
      });
    }

    override addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
      if (candidate?.candidate && !isLocalCandidate(candidate.candidate)) return Promise.resolve();
      return super.addIceCandidate(candidate);
    }

    override setConfiguration(config: RTCConfiguration): void {
      super.setConfiguration({ ...config, iceServers: [], iceCandidatePoolSize: 0 });
    }
  }
  localConnectionClass = LocalPeerConnection;
  return LocalPeerConnection;
}
