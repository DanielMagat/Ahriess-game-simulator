import { describe, it, expect } from "vitest";
import { resolveTargetSpec, isStillValidTarget } from "../src/resolution/targeting.js";
import { makeMatchState, addUnit, TestStatsRegistry } from "./helpers/fixtures.js";

describe("resolveTargetSpec — lane scope", () => {
  it("defaults to thisLane when laneScope is omitted", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1", "lane2", "lane3"]);
    state = addUnit(state, reg, { instanceId: "a", controllerId: "P1", laneId: "lane1", power: 1, toughness: 1 });
    state = addUnit(state, reg, { instanceId: "b", controllerId: "P1", laneId: "lane2", power: 1, toughness: 1 });

    const result = resolveTargetSpec(state, {}, { controllerId: "P1", sourceLaneId: "lane1" });
    expect(result.candidates.map((r) => r.objectId)).toEqual(["a"]);
  });

  it("adjacentLanes wraps around: leftmost and rightmost lanes are adjacent", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1", "lane2", "lane3", "lane4"]);
    state = addUnit(state, reg, { instanceId: "a", controllerId: "P1", laneId: "lane1", power: 1, toughness: 1 });
    state = addUnit(state, reg, { instanceId: "b", controllerId: "P1", laneId: "lane4", power: 1, toughness: 1 });
    state = addUnit(state, reg, { instanceId: "c", controllerId: "P1", laneId: "lane2", power: 1, toughness: 1 });

    // lane1's neighbors should be lane4 (wraparound) and lane2 — not lane3.
    const result = resolveTargetSpec(
      state,
      { laneScope: "adjacentLanes" },
      { controllerId: "P1", sourceLaneId: "lane1" }
    );
    expect(new Set(result.candidates.map((r) => r.objectId))).toEqual(
      new Set(["a", "b", "c"].filter((x) => x !== "a"))
    );
  });

  it("allLanes and otherLanes", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1", "lane2"]);
    state = addUnit(state, reg, { instanceId: "a", controllerId: "P1", laneId: "lane1", power: 1, toughness: 1 });
    state = addUnit(state, reg, { instanceId: "b", controllerId: "P1", laneId: "lane2", power: 1, toughness: 1 });

    const all = resolveTargetSpec(state, { laneScope: "allLanes" }, { controllerId: "P1", sourceLaneId: "lane1" });
    expect(new Set(all.candidates.map((r) => r.objectId))).toEqual(new Set(["a", "b"]));

    const other = resolveTargetSpec(state, { laneScope: "otherLanes" }, { controllerId: "P1", sourceLaneId: "lane1" });
    expect(other.candidates.map((r) => r.objectId)).toEqual(["b"]);
  });
});

describe("resolveTargetSpec — allegiance", () => {
  it("filters to allied or enemy relative to the effect's controller", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "mine", controllerId: "P1", laneId: "lane1", power: 1, toughness: 1 });
    state = addUnit(state, reg, { instanceId: "theirs", controllerId: "P2", laneId: "lane1", power: 1, toughness: 1 });

    const allied = resolveTargetSpec(state, { allegiance: "allied" }, { controllerId: "P1", sourceLaneId: "lane1" });
    expect(allied.candidates.map((r) => r.objectId)).toEqual(["mine"]);

    const enemy = resolveTargetSpec(state, { allegiance: "enemy" }, { controllerId: "P1", sourceLaneId: "lane1" });
    expect(enemy.candidates.map((r) => r.objectId)).toEqual(["theirs"]);
  });
});

describe("resolveTargetSpec — position", () => {
  it("first/last apply within each (lane, player) grouping independently", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    for (const id of ["p1a", "p1b", "p1c"]) {
      state = addUnit(state, reg, { instanceId: id, controllerId: "P1", laneId: "lane1", power: 1, toughness: 1 });
    }
    for (const id of ["p2a", "p2b"]) {
      state = addUnit(state, reg, { instanceId: id, controllerId: "P2", laneId: "lane1", power: 1, toughness: 1 });
    }

    const first = resolveTargetSpec(state, { position: "first" }, { controllerId: "P1", sourceLaneId: "lane1" });
    expect(new Set(first.candidates.map((r) => r.objectId))).toEqual(new Set(["p1a", "p2a"]));

    const last = resolveTargetSpec(state, { position: "last" }, { controllerId: "P1", sourceLaneId: "lane1" });
    expect(new Set(last.candidates.map((r) => r.objectId))).toEqual(new Set(["p1c", "p2b"]));
  });
});

describe("resolveTargetSpec — zone-based (hand/graveyard/deck)", () => {
  it("resolves whose zone via allegiance, same as battlefield allegiance", () => {
    let state = makeMatchState(["lane1"]);
    state.players.P1.zones.hand.push("h1", "h2");
    state.players.P2.zones.hand.push("h3");

    const mine = resolveTargetSpec(state, { zone: "hand", allegiance: "allied" }, { controllerId: "P1" });
    expect(mine.candidates.map((r) => r.objectId)).toEqual(["h1", "h2"]);

    const theirs = resolveTargetSpec(state, { zone: "hand", allegiance: "enemy" }, { controllerId: "P1" });
    expect(theirs.candidates.map((r) => r.objectId)).toEqual(["h3"]);
  });

  it("deckTopN takes the first N entries, treating index 0 as the top", () => {
    let state = makeMatchState(["lane1"]);
    state.players.P1.zones.deck.push("d1", "d2", "d3", "d4");
    const result = resolveTargetSpec(state, { zone: "deckTopN", allegiance: "allied", n: 2 }, { controllerId: "P1" });
    expect(result.candidates.map((r) => r.objectId)).toEqual(["d1", "d2"]);
  });
});

describe("resolveTargetSpec — needsPlayerChoice flag", () => {
  it("is true only when playerChooses is set, independent of how many candidates exist", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "a", controllerId: "P2", laneId: "lane1", power: 1, toughness: 1 });

    const auto = resolveTargetSpec(state, { allegiance: "enemy" }, { controllerId: "P1", sourceLaneId: "lane1" });
    expect(auto.needsPlayerChoice).toBe(false);

    const choice = resolveTargetSpec(
      state,
      { allegiance: "enemy", playerChooses: true },
      { controllerId: "P1", sourceLaneId: "lane1" }
    );
    expect(choice.needsPlayerChoice).toBe(true);
    expect(choice.candidates.map((r) => r.objectId)).toEqual(["a"]); // still computes the pool, just flags it
  });
});

describe("isStillValidTarget — re-validation at resolution time", () => {
  it("a target that left the battlefield is no longer valid", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "a", controllerId: "P2", laneId: "lane1", power: 1, toughness: 1 });
    const ref = { objectId: "a" };
    const criteria = { allegiance: "enemy" as const };
    const ctx = { controllerId: "P1", sourceLaneId: "lane1" };

    expect(isStillValidTarget(state, ref, criteria, ctx)).toBe(true);

    // Simulate the unit leaving the battlefield entirely (as if destroyed by
    // something else that resolved first).
    const { a: _removed, ...remainingUnits } = state.units;
    const afterDeath = { ...state, units: remainingUnits };
    expect(isStillValidTarget(afterDeath, ref, criteria, ctx)).toBe(false);
  });

  it("position is NOT re-checked — a target locked in as valid stays valid even if something else now sits 'first'", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, {
      instanceId: "original",
      controllerId: "P2",
      laneId: "lane1",
      power: 1,
      toughness: 1,
    });
    const ctx = { controllerId: "P1", sourceLaneId: "lane1" };
    const criteria = { allegiance: "enemy" as const, position: "first" as const };

    const locked = resolveTargetSpec(state, criteria, ctx).candidates;
    expect(locked.map((r) => r.objectId)).toEqual(["original"]);

    // A new enemy unit is inserted ahead of "original" in the attack sequence.
    state = {
      ...state,
      lanes: state.lanes.map((l) =>
        l.id === "lane1" ? { ...l, attackSequence: { ...l.attackSequence, P2: ["newcomer", "original"] } } : l
      ),
    };

    // "original" is no longer literally first, but it's still a valid re-validation
    // target — the locked reference isn't re-selected, just re-checked.
    expect(isStillValidTarget(state, locked[0], criteria, ctx)).toBe(true);
  });
});
