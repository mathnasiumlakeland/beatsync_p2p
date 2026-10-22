import { describe, expect, test } from "bun:test";
import { chooseHostClaim, successorPeerId } from "../host/election";

describe("host continuity", () => {
  test("a new listener does not displace an established host", () => {
    expect(chooseHostClaim([{ hostId: "z", term: 1 }], ["a", "z"])).toEqual({ hostId: "z", term: 1 });
  });
  test("simultaneous host claims converge independently of receive order", () => {
    const claims = [
      { hostId: "b", term: 1 },
      { hostId: "a", term: 1 },
    ];
    expect(chooseHostClaim(claims, ["b", "a"])?.hostId).toBe("a");
    expect(chooseHostClaim([...claims].reverse(), ["a", "b"])?.hostId).toBe("a");
  });
  test("rejects departed hosts and invalid terms", () => {
    expect(
      chooseHostClaim(
        [
          { hostId: "gone", term: 999 },
          { hostId: "a", term: NaN },
          { hostId: "a", term: -1 },
        ],
        ["a"]
      )
    ).toBeNull();
  });
  test("handover beats stale announcements and picks a consistent successor", () => {
    expect(
      chooseHostClaim(
        [
          { hostId: "a", term: 1 },
          { hostId: "b", term: 2 },
        ],
        ["a", "b"]
      )?.hostId
    ).toBe("b");
    expect(successorPeerId(["z", "c", "b"])).toBe("b");
    expect(successorPeerId([])).toBeNull();
  });
});
