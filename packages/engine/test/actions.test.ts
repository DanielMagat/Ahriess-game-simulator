import { describe, it, expect } from "vitest";
import {
  executeAction,
  computeCurrentStats,
  computeCurrentTypes,
  processStateBasedDeaths,
  moveZone,
  evaluateSearchQuery,
} from "../src/resolution/actions.js";
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

describe("executeAction — changeCardType", () => {
  it("Structure becoming a Unit is appended to the attack sequence, same as any new Unit", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, {
      instanceId: "u",
      controllerId: "P1",
      laneId: "lane1",
      power: 2,
      toughness: 2,
      types: ["Structure"],
    });
    // addUnit always seeds attackSequence — start this test from a clean slate
    // representing "was only ever tracked as a structure."
    state = {
      ...state,
      lanes: state.lanes.map((l) =>
        l.id === "lane1" ? { ...l, attackSequence: { P1: [], P2: [] }, structures: { P1: ["u"], P2: [] } } : l
      ),
    };

    const result = executeAction(
      state,
      { kind: "changeCardType", target: {}, from: ["Structure"], to: ["Unit"] },
      ctx,
      [{ objectId: "u" }],
      reg
    );

    expect(computeCurrentTypes(result.state, "u", reg)).toEqual(["Unit"]);
    expect(result.state.lanes[0].attackSequence.P1).toEqual(["u"]);
    expect(result.state.lanes[0].structures.P1).toEqual([]); // lost Structure, per from: ["Structure"]
    expect(result.events).toContainEqual({ type: "typeChanged", target: "u", before: ["Structure"], after: ["Unit"] });
  });

  it("adding a type without removing any (from: []) results in both types, present in both lists", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 2, toughness: 2 });
    // starts as ["Unit"] (addUnit's default) and already in attackSequence

    const result = executeAction(
      state,
      { kind: "changeCardType", target: {}, from: [], to: ["Structure"] },
      ctx,
      [{ objectId: "u" }],
      reg
    );

    expect(computeCurrentTypes(result.state, "u", reg)).toEqual(["Unit", "Structure"]);
    expect(result.state.lanes[0].attackSequence.P1).toEqual(["u"]); // still a Unit — untouched
    expect(result.state.lanes[0].structures.P1).toEqual(["u"]); // newly also a Structure
  });

  it("is a no-op (no crash, no event side effects beyond typeChanged) for a target not on the battlefield", () => {
    const reg = new TestStatsRegistry();
    const state = makeMatchState(["lane1"]);
    const result = executeAction(
      state,
      { kind: "changeCardType", target: {}, from: [], to: ["Unit"] },
      ctx,
      [{ objectId: "nowhere" }],
      reg
    );
    expect(result.events).toEqual([]);
    expect(result.state).toEqual(state);
  });
});

describe("executeAction — massIncrement", () => {
  it("increments only BENEFICIAL counters on an ally, leaving detrimental ones untouched", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "ally", controllerId: "P1", laneId: "lane1", power: 2, toughness: 5 });
    state = {
      ...state,
      cardInstances: {
        ...state.cardInstances,
        ally: {
          ...state.cardInstances.ally,
          countersByMode: {
            A: [
              { name: "+1/+1", count: 2, semantics: "builtin", polarity: "beneficial" },
              { name: "poison", count: 3, semantics: "builtin", polarity: "detrimental" },
            ],
            B: [],
          },
        },
      },
    };

    // ctx.controllerId is "P1" — same as ally's controller — so this is mass-incrementing an ally.
    const result = executeAction(state, { kind: "massIncrement", target: {} }, ctx, [{ objectId: "ally" }]);

    const counters = result.state.cardInstances.ally.countersByMode.A;
    expect(counters).toContainEqual({ name: "+1/+1", count: 3, semantics: "builtin", polarity: "beneficial" });
    expect(counters).toContainEqual({ name: "poison", count: 3, semantics: "builtin", polarity: "detrimental" }); // untouched
    expect(result.events).toContainEqual({
      type: "massIncremented",
      target: "ally",
      polarity: "beneficial",
      counterNames: ["+1/+1"],
    });
  });

  it("increments only DETRIMENTAL counters on an enemy, leaving beneficial ones untouched", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "foe", controllerId: "P2", laneId: "lane1", power: 2, toughness: 5 });
    state = {
      ...state,
      cardInstances: {
        ...state.cardInstances,
        foe: {
          ...state.cardInstances.foe,
          countersByMode: {
            A: [
              { name: "shield", count: 1, semantics: "builtin", polarity: "beneficial" },
              { name: "poison", count: 1, semantics: "builtin", polarity: "detrimental" },
            ],
            B: [],
          },
        },
      },
    };

    // ctx.controllerId is "P1" — foe is controlled by P2 — so this is mass-incrementing an enemy.
    const result = executeAction(state, { kind: "massIncrement", target: {} }, ctx, [{ objectId: "foe" }]);

    const counters = result.state.cardInstances.foe.countersByMode.A;
    expect(counters).toContainEqual({ name: "shield", count: 1, semantics: "builtin", polarity: "beneficial" }); // untouched
    expect(counters).toContainEqual({ name: "poison", count: 2, semantics: "builtin", polarity: "detrimental" });
    expect(result.events).toContainEqual({
      type: "massIncremented",
      target: "foe",
      polarity: "detrimental",
      counterNames: ["poison"],
    });
  });

  it("never creates a counter that isn't already there — only bumps existing ones", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "ally", controllerId: "P1", laneId: "lane1", power: 2, toughness: 5 });
    // no counters at all

    const result = executeAction(state, { kind: "massIncrement", target: {} }, ctx, [{ objectId: "ally" }]);
    expect(result.state.cardInstances.ally.countersByMode.A).toEqual([]);
    expect(result.events).toContainEqual({
      type: "massIncremented",
      target: "ally",
      polarity: "beneficial",
      counterNames: [],
    });
  });
});

describe("executeAction — energy/influence economy", () => {
  it("gainEnergy(temporary) adds to current only, not max — can exceed max", () => {
    const state = makeMatchState(["lane1"]);
    const result = executeAction(state, { kind: "gainEnergy", amount: 2, temporary: true }, ctx, []);
    expect(result.state.players.P1.energy).toEqual({ current: 7, max: 5 });
    expect(result.events).toContainEqual({ type: "energyGained", playerId: "P1", amount: 2, temporary: true });
  });

  it("gainEnergy(permanent) adds to both current and max together", () => {
    const state = makeMatchState(["lane1"]);
    const result = executeAction(state, { kind: "gainEnergy", amount: 1, temporary: false }, ctx, []);
    expect(result.state.players.P1.energy).toEqual({ current: 6, max: 6 });
  });

  it("gainInfluence adds to the specified color's pool", () => {
    const state = makeMatchState(["lane1"]);
    const result = executeAction(state, { kind: "gainInfluence", color: "E", amount: 2 }, ctx, []);
    expect(result.state.players.P1.influence.E).toBe(2);
    expect(result.events).toContainEqual({ type: "influenceGained", playerId: "P1", color: "E", amount: 2 });
  });

  it("gainInfluence with color: 'choice' is a flagged no-op — no decision-checkpoint mechanism exists yet", () => {
    const state = makeMatchState(["lane1"]);
    const result = executeAction(state, { kind: "gainInfluence", color: "choice", amount: 2 }, ctx, []);
    expect(result.state).toEqual(state); // untouched
    expect(result.events).toContainEqual({ type: "colorChoiceNotImplemented", action: "gainInfluence" });
  });

  it("spendInfluence subtracts from the specified color's pool, clamped at 0", () => {
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      players: { ...state.players, P1: { ...state.players.P1, influence: { ...state.players.P1.influence, S: 3 } } },
    };
    const result = executeAction(state, { kind: "spendInfluence", color: "S", amount: 5 }, ctx, []);
    expect(result.state.players.P1.influence.S).toBe(0); // clamped, not -2
    expect(result.events).toContainEqual({ type: "influenceSpent", playerId: "P1", color: "S", amount: 5 });
  });
});

describe("executeAction — discard / returnToHand / exile", () => {
  it("discard moves a resolved hand-zone target to its owner's graveyard", () => {
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      players: { ...state.players, P1: { ...state.players.P1, zones: { ...state.players.P1.zones, hand: ["c1"] } } },
    };

    const result = executeAction(state, { kind: "discard", count: 1 }, ctx, [{ objectId: "c1" }]);
    expect(result.state.players.P1.zones.hand).toEqual([]);
    expect(result.state.players.P1.zones.graveyard).toEqual(["c1"]);
    expect(result.events).toContainEqual({ type: "discarded", target: "c1", playerId: "P1" });
  });

  it("discard silently does nothing for a target not actually in anyone's hand (e.g. no ability-level target was resolved)", () => {
    const state = makeMatchState(["lane1"]);
    const result = executeAction(state, { kind: "discard", count: 2 }, ctx, []);
    expect(result.state).toEqual(state);
    expect(result.events).toEqual([]);
  });

  it("returnToHand removes a battlefield unit and adds it to its controller's hand, discarding damage but keeping counters", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, {
      instanceId: "u",
      controllerId: "P2",
      laneId: "lane1",
      power: 1,
      toughness: 3,
      damage: 2,
    });
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

    const result = executeAction(state, { kind: "returnToHand", target: {} }, ctx, [{ objectId: "u" }]);
    expect(result.state.units.u).toBeUndefined(); // damage (and the whole battlefield overlay) is gone with it
    expect(result.state.players.P2.zones.hand).toEqual(["u"]);
    expect(result.state.cardInstances.u.countersByMode.A).toEqual([
      { name: "+1/+1", count: 1, semantics: "builtin", polarity: "beneficial" },
    ]); // persisted
    expect(result.events).toContainEqual({ type: "returnedToHand", target: "u", playerId: "P2" });
  });

  it("exile removes a battlefield unit and tracks it in a real, queryable exile zone (unlike destroy -> graveyard, this used to be untracked — no longer)", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 1, toughness: 3 });

    const result = executeAction(state, { kind: "exile", target: {} }, ctx, [{ objectId: "u" }]);
    expect(result.state.units.u).toBeUndefined();
    expect(result.state.players.P1.zones.hand).toEqual([]);
    expect(result.state.players.P1.zones.graveyard).toEqual([]); // not the graveyard...
    expect(result.state.players.P1.zones.exile).toEqual(["u"]); // ...it's genuinely IN exile, and findable there
    expect(result.events).toContainEqual({ type: "exiled", target: "u", playerId: "P1" });
  });
});

describe("moveZone — the general mechanism discard/exile/returnToHand delegate to", () => {
  it("moves a card between two non-battlefield zones as a plain array relocation", () => {
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      players: { ...state.players, P1: { ...state.players.P1, zones: { ...state.players.P1.zones, deck: ["c1"] } } },
    };
    const result = moveZone(state, "c1", { kind: "deck", playerId: "P1" }, { kind: "exile", playerId: "P1" });
    expect(result.state.players.P1.zones.deck).toEqual([]);
    expect(result.state.players.P1.zones.exile).toEqual(["c1"]);
    expect(result.events).toContainEqual({ type: "zoneChanged", target: "c1", to: "exile", playerId: "P1" });
  });

  it("leaving the battlefield tears down the BattlefieldUnit — damage is gone, counters survive on CardInstance", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, {
      instanceId: "u",
      controllerId: "P1",
      laneId: "lane1",
      power: 1,
      toughness: 3,
      damage: 2,
    });
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

    const result = moveZone(
      state,
      "u",
      { kind: "battlefield", playerId: "P1", laneId: "lane1" },
      { kind: "hand", playerId: "P1" }
    );
    expect(result.state.units.u).toBeUndefined();
    expect(result.state.players.P1.zones.hand).toEqual(["u"]);
    expect(result.state.cardInstances.u.countersByMode.A).toEqual([
      { name: "+1/+1", count: 1, semantics: "builtin", polarity: "beneficial" },
    ]);
  });

  it("entering the battlefield with an explicit mode commits it, and adds the object to attackSequence per its types", () => {
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: {
        c1: {
          instanceId: "c1",
          origin: { kind: "card", cardDefId: "def1" },
          countersByMode: { A: [], B: [] },
          activeMode: "A",
        },
      },
      players: { ...state.players, P1: { ...state.players.P1, zones: { ...state.players.P1.zones, hand: ["c1"] } } },
    };
    const reg = new TestStatsRegistry();
    reg.set("c1", "B", { power: 3, toughness: 3, types: ["Unit"] });

    const result = moveZone(
      state,
      "c1",
      { kind: "hand", playerId: "P1" },
      { kind: "battlefield", playerId: "P1", laneId: "lane1", mode: "B" },
      reg
    );
    expect(result.state.cardInstances.c1.activeMode).toBe("B");
    expect(result.state.units.c1).toEqual({
      instanceId: "c1",
      controllerId: "P1",
      laneId: "lane1",
      damage: 0,
      statusEffects: [],
    });
    expect(result.state.lanes[0].attackSequence.P1).toEqual(["c1"]);
    expect(result.events).toContainEqual({
      type: "enteredBattlefield",
      target: "c1",
      playerId: "P1",
      laneId: "lane1",
      mode: "B",
    });
  });

  it("entering the battlefield with NO explicit mode reuses the instance's existing activeMode (a recursion case)", () => {
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: {
        c1: {
          instanceId: "c1",
          origin: { kind: "card", cardDefId: "def1" },
          countersByMode: { A: [], B: [] },
          activeMode: "B",
        },
      },
      players: {
        ...state.players,
        P1: { ...state.players.P1, zones: { ...state.players.P1.zones, graveyard: ["c1"] } },
      },
    };
    const reg = new TestStatsRegistry();
    reg.set("c1", "B", { power: 3, toughness: 3, types: ["Unit"] });

    const result = moveZone(
      state,
      "c1",
      { kind: "graveyard", playerId: "P1" },
      { kind: "battlefield", playerId: "P1", laneId: "lane1" }, // no mode given
      reg
    );
    expect(result.state.cardInstances.c1.activeMode).toBe("B"); // unchanged, reused
    expect(result.state.units.c1).toBeDefined();
  });

  it("entering the battlefield with no mode AND no pre-existing activeMode flags rather than guesses", () => {
    let state = makeMatchState(["lane1"]);
    // A CardInstance always has SOME activeMode in this engine, so simulate the
    // "can't resolve a mode" case the only way it could actually arise: the
    // instance genuinely isn't in cardInstances at all (e.g. bad data).
    const result = moveZone(
      state,
      "ghost",
      { kind: "hand", playerId: "P1" },
      { kind: "battlefield", playerId: "P1", laneId: "lane1" }
    );
    expect(result.events).toContainEqual({ type: "moveZoneSourceMissing", target: "ghost" });
    expect(result.state.units.ghost).toBeUndefined();
  });

  it("a source that isn't actually where `from` claims is a flagged no-op, not a crash", () => {
    const state = makeMatchState(["lane1"]);
    const result = moveZone(state, "nowhere", { kind: "hand", playerId: "P1" }, { kind: "graveyard", playerId: "P1" });
    expect(result.events).toEqual([{ type: "moveZoneSourceMissing", target: "nowhere" }]);
    expect(result.state).toEqual(state);
  });
});

describe("executeAction — moveUnit (concrete destination lane, no adjacency logic — that's the caller's job)", () => {
  it("moves a unit to a new lane, appended to the end of its sequence, and removes it from the old lane", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1", "lane2"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 1, toughness: 3 });
    state = addUnit(state, reg, {
      instanceId: "already-there",
      controllerId: "P1",
      laneId: "lane2",
      power: 1,
      toughness: 1,
    });

    const result = executeAction(
      state,
      { kind: "moveUnit", target: {}, toLaneId: "lane2" },
      ctx,
      [{ objectId: "u" }],
      reg
    );
    expect(result.state.units.u.laneId).toBe("lane2");
    expect(result.state.lanes[0].attackSequence.P1).toEqual([]); // gone from lane1
    expect(result.state.lanes[1].attackSequence.P1).toEqual(["already-there", "u"]); // appended to the END
    expect(result.events).toContainEqual({ type: "unitMoved", target: "u", fromLaneId: "lane1", toLaneId: "lane2" });
  });

  it("moving to the lane it's already in is a no-op, not an error", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 1, toughness: 3 });
    const result = executeAction(
      state,
      { kind: "moveUnit", target: {}, toLaneId: "lane1" },
      ctx,
      [{ objectId: "u" }],
      reg
    );
    expect(result.state).toEqual(state);
    expect(result.events).toEqual([]);
  });
});

describe("evaluateSearchQuery — checks BOTH modes of a card independently against criteria", () => {
  function makeTwoModeCard(
    instanceId: string,
    reg: TestStatsRegistry,
    modeA: { cost: number; type: string },
    modeB: { cost: number; type: string }
  ) {
    reg.set(instanceId, "A", {
      cost: { energy: modeA.cost, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } },
      types: [modeA.type as never],
    });
    reg.set(instanceId, "B", {
      cost: { energy: modeB.cost, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } },
      types: [modeB.type as never],
    });
  }

  it("a card matching under only ONE of its two modes reports only that mode", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: {
        c1: {
          instanceId: "c1",
          origin: { kind: "card", cardDefId: "d1" },
          countersByMode: { A: [], B: [] },
          activeMode: "A",
        },
      },
    };
    makeTwoModeCard("c1", reg, { cost: 1, type: "Unit" }, { cost: 6, type: "Structure" });

    const matches = evaluateSearchQuery(state, ["c1"], { cost: { op: "eq", value: 1 } }, reg);
    expect(matches).toEqual([{ instanceId: "c1", matchingModes: ["A"] }]);
  });

  it("type + cost criteria are ANDed together", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: {
        c1: {
          instanceId: "c1",
          origin: { kind: "card", cardDefId: "d1" },
          countersByMode: { A: [], B: [] },
          activeMode: "A",
        },
      },
    };
    makeTwoModeCard("c1", reg, { cost: 5, type: "Unit" }, { cost: 5, type: "Structure" });

    // "a unit that costs 5" — mode A matches both clauses; mode B matches cost but not type.
    const matches = evaluateSearchQuery(state, ["c1"], { type: "Unit", cost: { op: "eq", value: 5 } }, reg);
    expect(matches).toEqual([{ instanceId: "c1", matchingModes: ["A"] }]);
  });

  it("a card matching under BOTH modes reports both", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: {
        c1: {
          instanceId: "c1",
          origin: { kind: "card", cardDefId: "d1" },
          countersByMode: { A: [], B: [] },
          activeMode: "A",
        },
      },
    };
    makeTwoModeCard("c1", reg, { cost: 2, type: "Unit" }, { cost: 2, type: "Structure" });

    const matches = evaluateSearchQuery(state, ["c1"], { cost: { op: "eq", value: 2 } }, reg);
    expect(matches).toEqual([{ instanceId: "c1", matchingModes: ["A", "B"] }]);
  });

  it("gt/lt comparisons work as expected", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: {
        c1: {
          instanceId: "c1",
          origin: { kind: "card", cardDefId: "d1" },
          countersByMode: { A: [], B: [] },
          activeMode: "A",
        },
      },
    };
    makeTwoModeCard("c1", reg, { cost: 5, type: "Unit" }, { cost: 5, type: "Unit" });

    expect(evaluateSearchQuery(state, ["c1"], { cost: { op: "gt", value: 3 } }, reg)).toHaveLength(1);
    expect(evaluateSearchQuery(state, ["c1"], { cost: { op: "lt", value: 3 } }, reg)).toHaveLength(0);
  });

  it("a Trap (no energy cost) never matches a cost criterion", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: {
        c1: {
          instanceId: "c1",
          origin: { kind: "card", cardDefId: "d1" },
          countersByMode: { A: [], B: [] },
          activeMode: "A",
        },
      },
    };
    reg.set("c1", "A", { types: ["Unit"], cost: { energy: 3, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } } });
    reg.set("c1", "B", { types: ["Trap"], cost: { influence: { E: 0, S: 0, I: 0, B: 1, wildcard: 0 } } }); // no energy field

    const matches = evaluateSearchQuery(state, ["c1"], { cost: { op: "gt", value: 0 } }, reg);
    expect(matches).toEqual([{ instanceId: "c1", matchingModes: ["A"] }]); // only A, never B
  });

  it("skips instanceIds that don't resolve to a real CardInstance rather than crashing", () => {
    const reg = new TestStatsRegistry();
    const state = makeMatchState(["lane1"]);
    expect(evaluateSearchQuery(state, ["nonexistent"], {}, reg)).toEqual([]);
  });
});

describe("executeAction — search (deck -> hand and deck -> battlefield destinations)", () => {
  function twoModeInstance(activeMode: "A" | "B" = "A") {
    return {
      instanceId: "c1",
      origin: { kind: "card" as const, cardDefId: "d1" },
      countersByMode: { A: [], B: [] },
      activeMode,
    };
  }

  it("exactly one match, destination hand: moves the whole card, uncommitted", () => {
    const reg = new TestStatsRegistry();
    reg.set("c1", "A", { types: ["Unit"], cost: { energy: 1, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } } });
    reg.set("c1", "B", { types: ["Trap"], cost: { influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } } });
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: { c1: twoModeInstance() },
      players: { ...state.players, P1: { ...state.players.P1, zones: { ...state.players.P1.zones, deck: ["c1"] } } },
    };

    const result = executeAction(
      state,
      { kind: "search", zone: "deck", criteria: { type: "Trap" }, destination: { kind: "hand" } },
      ctx,
      [],
      reg
    );
    expect(result.state.players.P1.zones.hand).toEqual(["c1"]);
    expect(result.state.cardInstances.c1.activeMode).toBe("A"); // NOT committed to Trap (mode B) — hand doesn't fix a mode
    expect(result.events).toContainEqual({ type: "searched", target: "c1", destination: "hand" });
  });

  it("exactly one match, exactly one qualifying mode, destination battlefield: commits to that specific mode", () => {
    const reg = new TestStatsRegistry();
    reg.set("c1", "A", {
      types: ["Unit"],
      power: 1,
      toughness: 1,
      cost: { energy: 1, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } },
    });
    reg.set("c1", "B", {
      types: ["Structure"],
      power: 0,
      toughness: 5,
      cost: { energy: 6, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } },
    });
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: { c1: twoModeInstance() },
      players: { ...state.players, P1: { ...state.players.P1, zones: { ...state.players.P1.zones, deck: ["c1"] } } },
    };

    const result = executeAction(
      state,
      {
        kind: "search",
        zone: "deck",
        criteria: { cost: { op: "eq", value: 1 } },
        destination: { kind: "battlefield" },
      },
      ctx, // ctx.sourceLaneId = "lane1" — used as the default destination lane
      [],
      reg
    );
    expect(result.state.cardInstances.c1.activeMode).toBe("A"); // committed to the mode that actually matched
    expect(result.state.units.c1).toBeDefined();
    expect(result.state.lanes[0].attackSequence.P1).toEqual(["c1"]);
    expect(result.events).toContainEqual({ type: "searched", target: "c1", destination: "battlefield" });
  });

  it("zero matches: a flagged no-op", () => {
    const reg = new TestStatsRegistry();
    const state = makeMatchState(["lane1"]);
    const result = executeAction(
      state,
      { kind: "search", zone: "deck", criteria: { type: "Trap" }, destination: { kind: "hand" } },
      ctx,
      [],
      reg
    );
    expect(result.events).toEqual([{ type: "searchFoundNothing" }]);
    expect(result.state).toEqual(state);
  });

  it("multiple matching cards: flags needsDecision rather than picking one", () => {
    const reg = new TestStatsRegistry();
    reg.set("c1", "A", { types: ["Unit"], cost: { energy: 1, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } } });
    reg.set("c2", "A", { types: ["Unit"], cost: { energy: 1, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } } });
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: { c1: twoModeInstance(), c2: { ...twoModeInstance(), instanceId: "c2" } },
      players: {
        ...state.players,
        P1: { ...state.players.P1, zones: { ...state.players.P1.zones, deck: ["c1", "c2"] } },
      },
    };

    const result = executeAction(
      state,
      { kind: "search", zone: "deck", criteria: { type: "Unit" }, destination: { kind: "hand" } },
      ctx,
      [],
      reg
    );
    expect(result.events).toContainEqual({
      type: "searchNeedsDecision",
      reason: "multiple cards matched",
      matchCount: 2,
    });
    expect(result.state).toEqual(state); // untouched
  });

  it("one matching card but BOTH its modes qualify, destination battlefield: flags needsDecision rather than picking a mode", () => {
    const reg = new TestStatsRegistry();
    reg.set("c1", "A", { types: ["Unit"], cost: { energy: 2, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } } });
    reg.set("c1", "B", {
      types: ["Structure"],
      cost: { energy: 2, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } },
    });
    let state = makeMatchState(["lane1"]);
    state = {
      ...state,
      cardInstances: { c1: twoModeInstance() },
      players: { ...state.players, P1: { ...state.players.P1, zones: { ...state.players.P1.zones, deck: ["c1"] } } },
    };

    const result = executeAction(
      state,
      {
        kind: "search",
        zone: "deck",
        criteria: { cost: { op: "eq", value: 2 } },
        destination: { kind: "battlefield" },
      },
      ctx,
      [],
      reg
    );
    expect(result.events).toContainEqual({
      type: "searchNeedsDecision",
      reason: "multiple modes of the matched card qualify",
      target: "c1",
    });
    expect(result.state.units.c1).toBeUndefined();
  });

  it("destination battlefield with an explicit laneId overrides the ability's own source lane", () => {
    const reg = new TestStatsRegistry();
    reg.set("c1", "A", { types: ["Unit"], cost: { energy: 1, influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } } });
    reg.set("c1", "B", { types: ["Trap"], cost: { influence: { E: 0, S: 0, I: 0, B: 0, wildcard: 0 } } });
    let state = makeMatchState(["lane1", "lane2"]);
    state = {
      ...state,
      cardInstances: { c1: twoModeInstance() },
      players: { ...state.players, P1: { ...state.players.P1, zones: { ...state.players.P1.zones, deck: ["c1"] } } },
    };

    const result = executeAction(
      state,
      {
        kind: "search",
        zone: "deck",
        criteria: { cost: { op: "eq", value: 1 } },
        destination: { kind: "battlefield", laneId: "lane2" },
      },
      ctx, // ctx.sourceLaneId is "lane1" — should be overridden
      [],
      reg
    );
    expect(result.state.units.c1.laneId).toBe("lane2");
  });
});
