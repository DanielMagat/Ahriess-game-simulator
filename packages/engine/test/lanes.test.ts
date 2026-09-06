import { describe, it, expect } from "vitest";
import { getEffectiveAdjacentLanes, isLaneDeactivated } from "../src/resolution/lanes.js";
import type { LaneState } from "../src/types/state.js";

function makeLanes(deactivated: Record<string, boolean> = {}): LaneState[] {
  return ["lane1", "lane2", "lane3", "lane4"].map((id) => ({
    id,
    locationId: `${id}-loc`,
    baseHealth: { P1: deactivated[id] ? 0 : 10, P2: 10 },
    attackSequence: { P1: [], P2: [] },
    structures: { P1: [], P2: [] },
  }));
}

describe("isLaneDeactivated", () => {
  it("is deactivated when either player's base health is 0", () => {
    const lanes = makeLanes({ lane2: true });
    expect(isLaneDeactivated(lanes[1])).toBe(true);
    expect(isLaneDeactivated(lanes[0])).toBe(false);
  });
});

describe("getEffectiveAdjacentLanes — worked examples confirmed by the game designer (2026-09)", () => {
  it("normal case: an interior lane's neighbors are its immediate predecessor/successor", () => {
    const lanes = makeLanes();
    expect(getEffectiveAdjacentLanes(lanes, "lane2")).toEqual(expect.arrayContaining(["lane1", "lane3"]));
    expect(getEffectiveAdjacentLanes(lanes, "lane2")).toHaveLength(2);
  });

  it("wraparound: lane 1 and lane 4 are adjacent, same as any other neighboring pair", () => {
    const lanes = makeLanes();
    expect(getEffectiveAdjacentLanes(lanes, "lane1")).toEqual(expect.arrayContaining(["lane4", "lane2"]));
    expect(getEffectiveAdjacentLanes(lanes, "lane4")).toEqual(expect.arrayContaining(["lane3", "lane1"]));
  });

  it("one lane deactivated: its former neighbors become adjacent to each other, skipping over it", () => {
    const lanes = makeLanes({ lane3: true });
    // "if lane 3 is deactivated, a card in lane 2 can move to 1 or 4"
    expect(getEffectiveAdjacentLanes(lanes, "lane2")).toEqual(expect.arrayContaining(["lane1", "lane4"]));
    expect(getEffectiveAdjacentLanes(lanes, "lane2")).toHaveLength(2);
  });

  it("a unit IN the deactivated lane can still see (and move to) its effective neighbors", () => {
    const lanes = makeLanes({ lane3: true });
    // a unit sitting in deactivated lane 3 can move into 2 or 4, but not 1
    const result = getEffectiveAdjacentLanes(lanes, "lane3");
    expect(result).toEqual(expect.arrayContaining(["lane2", "lane4"]));
    expect(result).not.toContain("lane1");
    expect(result).toHaveLength(2);
  });

  it("two lanes deactivated: units in EITHER deactivated lane can reach BOTH remaining active lanes", () => {
    const lanes = makeLanes({ lane2: true, lane3: true });
    const fromLane2 = getEffectiveAdjacentLanes(lanes, "lane2");
    const fromLane3 = getEffectiveAdjacentLanes(lanes, "lane3");
    expect(fromLane2).toEqual(expect.arrayContaining(["lane1", "lane4"]));
    expect(fromLane2).toHaveLength(2);
    expect(fromLane3).toEqual(expect.arrayContaining(["lane1", "lane4"]));
    expect(fromLane3).toHaveLength(2);
  });

  it("only one lane left active: every other lane's (deduped) effective neighbor is just that one", () => {
    const lanes = makeLanes({ lane1: true, lane2: true, lane3: true });
    expect(getEffectiveAdjacentLanes(lanes, "lane2")).toEqual(["lane4"]);
  });

  it("the sole remaining active lane itself has no legal destinations left", () => {
    const lanes = makeLanes({ lane1: true, lane2: true, lane3: true });
    expect(getEffectiveAdjacentLanes(lanes, "lane4")).toEqual([]);
  });

  it("an unknown lane id returns no neighbors rather than throwing", () => {
    const lanes = makeLanes();
    expect(getEffectiveAdjacentLanes(lanes, "nonexistent")).toEqual([]);
  });
});
