import { describe, it, expect } from "vitest";
import { executeAction, computeCurrentStats, processStateBasedDeaths } from "../src/resolution/actions.js";
import { makeMatchState, addUnit, TestStatsRegistry } from "./helpers/fixtures.js";

const ctx = { controllerId: "P1", sourceLaneId: "lane1" };

describe("computeCurrentStats", () => {
  it("combines base stats, +1/+1 and -1/-1 counters, statModifier status effects, and damage", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, {
      instanceId: "u",
      controllerId: "P1",
      laneId: "lane1",
      power: 3,
      toughness: 3,
      damage: 1,
    });
    state = {
      ...state,
      cardInstances: {
        ...state.cardInstances,
        u: {
          ...state.cardInstances.u,
          countersByMode: { A: [{ name: "+1/+1", count: 2, semantics: "builtin", polarity: "beneficial" }], B: [] },
        },
      },
      units: {
        ...state.units,
        u: {
          ...state.units.u,
          statusEffects: [{ kind: "statModifier", power: 1, toughness: -1, expiresAt: { kind: "permanent" } }],
        },
      },
    };

    // base 3/3, +2/+2 from counters -> 5/5, +1/-1 from status -> 6/4, -1 damage -> 6/3
    const stats = computeCurrentStats(state, "u", reg);
    expect(stats).toEqual({ power: 6, toughness: 3 });
  });

  it("returns empty for an instance not currently on the battlefield", () => {
    const reg = new TestStatsRegistry();
    const state = makeMatchState(["lane1"]);
    expect(computeCurrentStats(state, "nonexistent", reg)).toEqual({});
  });
});

describe("executeAction — dealDamage / heal", () => {
  it("dealDamage increases damage; heal decreases it, floored at 0", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P2", laneId: "lane1", power: 2, toughness: 5 });

    let result = executeAction(state, { kind: "dealDamage", amount: 3, target: {} }, ctx, [{ objectId: "u" }]);
    state = result.state;
    expect(state.units.u.damage).toBe(3);

    result = executeAction(state, { kind: "heal", amount: 5, target: {} }, ctx, [{ objectId: "u" }]);
    state = result.state;
    expect(state.units.u.damage).toBe(0); // floored, not -2
  });
});

describe("executeAction — counters", () => {
  it("addCounter creates a new counter or stacks an existing one; removeCounter drops it at 0", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 1, toughness: 1 });

    let result = executeAction(state, { kind: "addCounter", counterName: "+1/+1", amount: 2, target: {} }, ctx, [
      { objectId: "u" },
    ]);
    state = result.state;
    expect(state.cardInstances.u.countersByMode.A).toEqual([
      { name: "+1/+1", count: 2, semantics: "builtin", polarity: "beneficial" },
    ]);

    result = executeAction(state, { kind: "addCounter", counterName: "+1/+1", amount: 1, target: {} }, ctx, [
      { objectId: "u" },
    ]);
    state = result.state;
    expect(state.cardInstances.u.countersByMode.A[0].count).toBe(3);

    result = executeAction(state, { kind: "removeCounter", counterName: "+1/+1", amount: 3, target: {} }, ctx, [
      { objectId: "u" },
    ]);
    state = result.state;
    expect(state.cardInstances.u.countersByMode.A).toEqual([]); // dropped entirely at 0, not left at count 0
  });

  it("generic (non-builtin) counters are explicitly unsupported, not silently guessed", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 1, toughness: 1 });

    const result = executeAction(state, { kind: "addCounter", counterName: "thirst", amount: 1, target: {} }, ctx, [
      { objectId: "u" },
    ]);
    expect(result.events).toContainEqual({
      type: "counterUnsupported",
      counterName: "thirst",
      reason: "generic counters not yet implemented",
    });
    expect(result.state.cardInstances.u.countersByMode.A).toEqual([]);
  });
});

describe("executeAction — freeze / buffStat", () => {
  it("freeze attaches a frozen status effect", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P2", laneId: "lane1", power: 1, toughness: 1 });
    const result = executeAction(state, { kind: "freeze", target: {}, duration: { kind: "untilNextCombat" } }, ctx, [
      { objectId: "u" },
    ]);
    expect(result.state.units.u.statusEffects).toEqual([{ kind: "frozen", expiresAt: { kind: "untilNextCombat" } }]);
  });

  it("buffStat supports asymmetric power/toughness deltas that +1/+1 counters can't express", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 2, toughness: 2 });
    const result = executeAction(
      state,
      { kind: "buffStat", power: 2, toughness: 0, target: {}, duration: { kind: "permanent" } },
      ctx,
      [{ objectId: "u" }]
    );
    expect(computeCurrentStats(result.state, "u", reg)).toEqual({ power: 4, toughness: 2 });
  });
});

describe("executeAction — dealDamage respects shield/plating", () => {
  it("shield fully prevents the hit and depletes by 1, leaving no damage", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P2", laneId: "lane1", power: 1, toughness: 5 });
    state = {
      ...state,
      cardInstances: {
        ...state.cardInstances,
        u: {
          ...state.cardInstances.u,
          countersByMode: { A: [{ name: "shield", count: 1, semantics: "builtin", polarity: "beneficial" }], B: [] },
        },
      },
    };

    const result = executeAction(state, { kind: "dealDamage", amount: 5, target: {} }, ctx, [{ objectId: "u" }]);
    expect(result.state.units.u.damage).toBe(0);
    expect(result.state.cardInstances.u.countersByMode.A).toEqual([]); // shield depleted to 0, dropped
    expect(result.events).toContainEqual({ type: "shieldPrevented", target: "u" });
    expect(result.events.some((e) => e.type === "damage")).toBe(false);
  });

  it("plating reduces the hit by its current count, then depletes by exactly 1 regardless", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P2", laneId: "lane1", power: 1, toughness: 5 });
    state = {
      ...state,
      cardInstances: {
        ...state.cardInstances,
        u: {
          ...state.cardInstances.u,
          countersByMode: { A: [{ name: "plating", count: 2, semantics: "builtin", polarity: "beneficial" }], B: [] },
        },
      },
    };

    const result = executeAction(state, { kind: "dealDamage", amount: 5, target: {} }, ctx, [{ objectId: "u" }]);
    expect(result.state.units.u.damage).toBe(3); // 5 - 2 plating
    expect(result.state.cardInstances.u.countersByMode.A).toEqual([
      { name: "plating", count: 1, semantics: "builtin", polarity: "beneficial" },
    ]);
    expect(result.events).toContainEqual({ type: "platingReduced", target: "u", rawAmount: 5, reducedAmount: 3 });
    expect(result.events).toContainEqual({ type: "damage", target: "u", amount: 3 });
  });
});

describe("executeAction — destroy respects shield (but not plating)", () => {
  it("shield negates a destroy instead of moving the unit to the graveyard, then depletes", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P2", laneId: "lane1", power: 1, toughness: 1 });
    state = {
      ...state,
      cardInstances: {
        ...state.cardInstances,
        u: {
          ...state.cardInstances.u,
          countersByMode: { A: [{ name: "shield", count: 1, semantics: "builtin", polarity: "beneficial" }], B: [] },
        },
      },
    };

    const first = executeAction(state, { kind: "destroy", target: {} }, ctx, [{ objectId: "u" }]);
    expect(first.state.units.u).toBeDefined(); // still alive — shield absorbed it
    expect(first.state.cardInstances.u.countersByMode.A).toEqual([]); // shield consumed
    expect(first.events).toContainEqual({ type: "shieldPrevented", target: "u" });

    const second = executeAction(first.state, { kind: "destroy", target: {} }, ctx, [{ objectId: "u" }]);
    expect(second.state.units.u).toBeUndefined(); // no shield left — destroy goes through
    expect(second.state.players.P2.zones.graveyard).toEqual(["u"]);
  });
});

describe("executeAction — destroy / sacrifice", () => {
  it("both move the unit off the battlefield and into its controller's graveyard, counters intact", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P2", laneId: "lane1", power: 1, toughness: 1 });
    state = {
      ...state,
      cardInstances: {
        ...state.cardInstances,
        u: {
          ...state.cardInstances.u,
          countersByMode: { A: [{ name: "+1/+1", count: 1, semantics: "builtin", polarity: "beneficial" }], B: [] },
        },
      },
    };

    const result = executeAction(state, { kind: "destroy", target: {} }, ctx, [{ objectId: "u" }]);
    expect(result.state.units.u).toBeUndefined();
    expect(result.state.lanes[0].attackSequence.P2).toEqual([]);
    expect(result.state.players.P2.zones.graveyard).toEqual(["u"]);
    // Counters survive the zone change — only damage doesn't (spec §4).
    expect(result.state.cardInstances.u.countersByMode.A).toEqual([
      { name: "+1/+1", count: 1, semantics: "builtin", polarity: "beneficial" },
    ]);
  });
});

describe("executeAction — draw", () => {
  it("moves cards from the controller's deck (top = index 0) to hand", () => {
    let state = makeMatchState(["lane1"]);
    state.players.P1.zones.deck.push("d1", "d2", "d3");
    const result = executeAction(state, { kind: "draw", count: 2 }, ctx, []);
    expect(result.state.players.P1.zones.hand).toEqual(["d1", "d2"]);
    expect(result.state.players.P1.zones.deck).toEqual(["d3"]);
  });

  it("draws only as many as are left rather than erroring on an empty-ish deck", () => {
    let state = makeMatchState(["lane1"]);
    state.players.P1.zones.deck.push("d1");
    const result = executeAction(state, { kind: "draw", count: 5 }, ctx, []);
    expect(result.state.players.P1.zones.hand).toEqual(["d1"]);
    expect(result.state.players.P1.zones.deck).toEqual([]);
  });
});

describe("executeAction — unimplemented primitives are explicit, not silent", () => {
  it("emits actionNotImplemented rather than doing nothing invisibly", () => {
    const state = makeMatchState(["lane1"]);
    const result = executeAction(state, { kind: "copy", target: {} }, ctx, []);
    expect(result.events).toContainEqual({ type: "actionNotImplemented", kind: "copy" });
  });
});

describe("processStateBasedDeaths", () => {
  it("sweeps every unit with lethal toughness to the graveyard in one pass", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, {
      instanceId: "alive",
      controllerId: "P1",
      laneId: "lane1",
      power: 1,
      toughness: 3,
      damage: 1,
    });
    state = addUnit(state, reg, {
      instanceId: "dead",
      controllerId: "P2",
      laneId: "lane1",
      power: 1,
      toughness: 3,
      damage: 3,
    });

    const result = processStateBasedDeaths(state, reg);
    expect(result.state.units.alive).toBeDefined();
    expect(result.state.units.dead).toBeUndefined();
    expect(result.state.players.P2.zones.graveyard).toEqual(["dead"]);
    expect(result.events).toContainEqual({ type: "unitDied", instanceId: "dead" });
  });
});
