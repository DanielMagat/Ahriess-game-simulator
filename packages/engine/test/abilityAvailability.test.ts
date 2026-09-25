import { describe, it, expect } from "vitest";
import {
  isUsageAvailable,
  recordAbilityUsage,
  isAbilityNegated,
  UsageContext,
} from "../src/resolution/abilityAvailability.js";
import type { Ability } from "../src/types/abilities.js";
import type { CardInstance, MatchState } from "../src/types/state.js";
import { makeMatchState, addUnit, TestStatsRegistry } from "./helpers/fixtures.js";

const baseInstance: CardInstance = {
  instanceId: "c1",
  origin: { kind: "token", tokenDefId: "d1" },
  countersByMode: { A: [], B: [] },
  activeMode: "A",
};

const ctx = (turnNumber: number, combatNumber = 0): UsageContext => ({ turnNumber, combatNumber });

describe("isUsageAvailable / recordAbilityUsage — spec §4/§9 usage limits, generalized off Activated", () => {
  it("an ability with no usageLimit is always available", () => {
    const ability: Ability = { trigger: { kind: "EtB" }, action: [] };
    expect(isUsageAvailable(baseInstance, ability, ctx(1))).toBe(true);
  });

  it("an ability with a usageLimit but no id is always available (nothing to key a record by)", () => {
    const ability: Ability = { trigger: { kind: "SoT" }, action: [], usageLimit: { kind: "perGame", n: 1 } };
    expect(isUsageAvailable(baseInstance, ability, ctx(1))).toBe(true);
  });

  it("perGame(1): available before first use, unavailable after, on ANY later turn — never resets", () => {
    const ability: Ability = {
      id: "drawOnCondition",
      trigger: { kind: "SoT" },
      action: [],
      usageLimit: { kind: "perGame", n: 1 },
    };
    expect(isUsageAvailable(baseInstance, ability, ctx(1))).toBe(true);

    const usedOnce = recordAbilityUsage(baseInstance, ability, ctx(1));
    expect(isUsageAvailable(usedOnce, ability, ctx(1))).toBe(false);
    expect(isUsageAvailable(usedOnce, ability, ctx(7))).toBe(false); // still unavailable many turns later
  });

  it("perGame(3): a real confirmed shape — 'thrice per game' — available for the first three uses, then not", () => {
    const ability: Ability = { id: "x", trigger: { kind: "EtB" }, action: [], usageLimit: { kind: "perGame", n: 3 } };
    let instance = baseInstance;
    for (let i = 0; i < 3; i++) {
      expect(isUsageAvailable(instance, ability, ctx(1))).toBe(true);
      instance = recordAbilityUsage(instance, ability, ctx(1));
    }
    expect(isUsageAvailable(instance, ability, ctx(99))).toBe(false); // 3 uses spent, no turn resets this
  });

  it("perTurn(1): unavailable on the SAME turn it was used, available again once the turn number changes", () => {
    const ability: Ability = {
      id: "activatedThing",
      trigger: { kind: "Activated", energyCost: 1 },
      action: [],
      usageLimit: { kind: "perTurn", n: 1 },
    };
    const usedOnTurn3 = recordAbilityUsage(baseInstance, ability, ctx(3));
    expect(isUsageAvailable(usedOnTurn3, ability, ctx(3))).toBe(false);
    expect(isUsageAvailable(usedOnTurn3, ability, ctx(4))).toBe(true); // new turn — reset
  });

  it("using a perTurn ability again on a NEW turn correctly resets the count rather than accumulating", () => {
    const ability: Ability = {
      id: "x",
      trigger: { kind: "Activated", energyCost: 1 },
      action: [],
      usageLimit: { kind: "perTurn", n: 1 },
    };
    let instance = recordAbilityUsage(baseInstance, ability, ctx(3));
    instance = recordAbilityUsage(instance, ability, ctx(4)); // used again on turn 4
    expect(instance.abilityUsage?.["x:0"]).toEqual({ scopeId: 4, count: 1 }); // not 2 — turn 3's use doesn't carry over
    expect(isUsageAvailable(instance, ability, ctx(4))).toBe(false);
    expect(isUsageAvailable(instance, ability, ctx(5))).toBe(true);
  });

  it("perCombat(1) usually coincides with perTurn but is tracked independently — differs when a second combat happens in the same turn", () => {
    const ability: Ability = {
      id: "x",
      trigger: { kind: "StartOfCombat" },
      action: [],
      usageLimit: { kind: "perCombat", n: 1 },
    };
    // Turn 5, first combat (combatNumber 10): used once.
    let instance = recordAbilityUsage(baseInstance, ability, ctx(5, 10));
    expect(isUsageAvailable(instance, ability, ctx(5, 10))).toBe(false);
    // Still turn 5, but a Location granted the attack token back — a SECOND
    // combat within the same turn (combatNumber advances even though turnNumber
    // doesn't). perCombat resets; perTurn would not have.
    expect(isUsageAvailable(instance, ability, ctx(5, 11))).toBe(true);
  });

  it("compound: 'once per turn, thrice per game' — confirmed real shape. Usable only while BOTH have room, and one use counts against both at once", () => {
    const ability: Ability = {
      id: "x",
      trigger: { kind: "SoT" },
      action: [],
      usageLimit: {
        kind: "compound",
        limits: [
          { kind: "perTurn", n: 1 },
          { kind: "perGame", n: 3 },
        ],
      },
    };

    let instance = baseInstance;
    // Turn 1: usable once, then blocked by the perTurn component for the rest of turn 1.
    expect(isUsageAvailable(instance, ability, ctx(1))).toBe(true);
    instance = recordAbilityUsage(instance, ability, ctx(1));
    expect(isUsageAvailable(instance, ability, ctx(1))).toBe(false); // perTurn component blocks it

    // Turn 2: perTurn component resets, so it's usable again — 2nd game-wide use.
    expect(isUsageAvailable(instance, ability, ctx(2))).toBe(true);
    instance = recordAbilityUsage(instance, ability, ctx(2));

    // Turn 3: 3rd and final game-wide use.
    expect(isUsageAvailable(instance, ability, ctx(3))).toBe(true);
    instance = recordAbilityUsage(instance, ability, ctx(3));

    // Turn 4: perTurn component alone would allow it, but perGame's 3 uses are spent — blocked.
    expect(isUsageAvailable(instance, ability, ctx(4))).toBe(false);
  });

  it("two DIFFERENT abilities on the same instance track independently — using one doesn't affect the other", () => {
    const abilityA: Ability = {
      id: "abilityA",
      trigger: { kind: "EtB" },
      action: [],
      usageLimit: { kind: "perGame", n: 1 },
    };
    const abilityB: Ability = {
      id: "abilityB",
      trigger: { kind: "Fall" },
      action: [],
      usageLimit: { kind: "perGame", n: 1 },
    };
    const instance = recordAbilityUsage(baseInstance, abilityA, ctx(1));
    expect(isUsageAvailable(instance, abilityA, ctx(1))).toBe(false); // used up
    expect(isUsageAvailable(instance, abilityB, ctx(1))).toBe(true); // untouched — the game designer's specific concern
  });
});

describe("isAbilityNegated", () => {
  function stateWithNegatedUnit(negation: import("../src/types/state.js").StatusEffect): MatchState {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 1, toughness: 3 });
    return { ...state, units: { ...state.units, u: { ...state.units.u, statusEffects: [negation] } } };
  }

  it("allAbilitiesOfObject silences every ability on the object, regardless of id", () => {
    const state = stateWithNegatedUnit({
      kind: "negated",
      scope: "allAbilitiesOfObject",
      expiresAt: { kind: "permanent" },
    });
    const abilityX: Ability = { id: "x", trigger: { kind: "EtB" }, action: [] };
    const abilityNoId: Ability = { trigger: { kind: "Fall" }, action: [] };
    expect(isAbilityNegated(state, "u", abilityX, undefined)).toBe(true);
    expect(isAbilityNegated(state, "u", abilityNoId, undefined)).toBe(true);
  });

  it("thisAbilityOnly silences the matching ability but leaves a DIFFERENT ability on the same object functional", () => {
    const state = stateWithNegatedUnit({
      kind: "negated",
      scope: "thisAbilityOnly",
      abilityId: "silencedOne",
      expiresAt: { kind: "permanent" },
    });
    const silenced: Ability = { id: "silencedOne", trigger: { kind: "EtB" }, action: [] };
    const stillWorks: Ability = { id: "otherAbility", trigger: { kind: "Fall" }, action: [] };
    expect(isAbilityNegated(state, "u", silenced, undefined)).toBe(true);
    expect(isAbilityNegated(state, "u", stillWorks, undefined)).toBe(false); // the game designer's specific concern
  });

  it("a unit with no negation status effects is never negated", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 1, toughness: 3 });
    const ability: Ability = { id: "x", trigger: { kind: "EtB" }, action: [] };
    expect(isAbilityNegated(state, "u", ability, undefined)).toBe(false);
  });

  it("allCardsMatchingName checks MatchState.activeNameNegations globally, not the object's own statusEffects", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 1, toughness: 3 });
    state = { ...state, activeNameNegations: [{ cardName: "Fireball", expiresAt: { kind: "permanent" } }] };

    const ability: Ability = { id: "x", trigger: { kind: "EtB" }, action: [] };
    expect(isAbilityNegated(state, "u", ability, "Fireball")).toBe(true);
    expect(isAbilityNegated(state, "u", ability, "Some Other Card")).toBe(false);
  });

  it("allCardsMatchingName with no cardName provided (card loading not built yet) never matches, rather than guessing", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "u", controllerId: "P1", laneId: "lane1", power: 1, toughness: 3 });
    state = { ...state, activeNameNegations: [{ cardName: "Fireball", expiresAt: { kind: "permanent" } }] };

    const ability: Ability = { id: "x", trigger: { kind: "EtB" }, action: [] };
    expect(isAbilityNegated(state, "u", ability, undefined)).toBe(false);
  });
});
