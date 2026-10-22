export interface HostClaim {
  hostId: string;
  term: number;
}

/** Existing hosts keep their role; simultaneous claims converge without wall clocks. */
export function chooseHostClaim(claims: HostClaim[], onlinePeerIds: string[]): HostClaim | null {
  return (
    claims
      .filter((claim) => onlinePeerIds.includes(claim.hostId) && Number.isSafeInteger(claim.term) && claim.term > 0)
      .sort((a, b) => b.term - a.term || (a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0))[0] ?? null
  );
}

export function successorPeerId(peerIds: string[]): string | null {
  return [...peerIds].sort()[0] ?? null;
}
