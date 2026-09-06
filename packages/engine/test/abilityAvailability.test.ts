import { describe, it, expect } from "vitest";
import { isUsageAvailable, recordAbilityUsage, isAbilityNegated } from "../src/resolution/abilityAvailability.js";
import type { Ability } from "../src/types/abilities.js";
import type { CardInstance, MatchState } from "../src/types/state.js";
import { makeMatchState, addUnit, TestStatsRegistry } from "./helpers/fixtures.js";

const baseInstance: CardInstance = {
  instanceId: "c1",
  origin: { kind: "token", tokenDefId: "d1" },
  countersByMode: { A: [], B: [] },
  activeMode: "A",
};

describe("isUsageAvailable / recordAbilityUsage — spec §4/§9 usage limits, generalized off Activated", () => {
  it("an ability with no usageLimit is always available", () => {
    const ability: Ability = { trigger: { kind: "EtB" }, action: [] };
    expect(isUsageAvailable(baseInstance, ability, 1)).toBe(true);
  });

  it("an ability with a usageLimit but no id is always available (nothing to key a record by)", () => {
    const ability: Ability = { trigger: { kind: "SoT" }, action: [], usageLimit: "oncePerGame" };
    expect(isUsageAvailable(baseInstance, ability, 1)).toBe(true);
  });

  it("oncePerGame: available before first use, unavailable after, on ANY later turn — never resets", () => {
    const ability: Ability = { id: "drawOnCondition", trigger: { kind: "SoT" }, action: [], usageLimit: "oncePerGame" };
    expect(isUsageAvailable(baseInstance, ability, 1)).toBe(true);

    const usedOnce = recordAbilityUsage(baseInstance, ability, 1);
    expect(isUsageAvailable(usedOnce, ability, 1)).toBe(false);
    expect(isUsageAvailable(usedOnce, ability, 7)).toBe(false); // still unavailable many turns later
  });

  it("oncePerTurn: unavailable on the SAME turn it was used, available again once the turn number changes", () => {
    const ability: Ability = {
      id: "activatedThing",
      trigger: { kind: "Activated", energyCost: 1 },
      action: [],
      usageLimit: "oncePerTurn",
    };
    const usedOnTurn3 = recordAbilityUsage(baseInstance, ability, 3);
    expect(isUsageAvailable(usedOnTurn3, ability, 3)).toBe(false);
    expect(isUsageAvailable(usedOnTurn3, ability, 4)).toBe(true); // new turn — reset
  });

  it("using an oncePerTurn ability again on a NEW turn correctly resets the count rather than accumulating", () => {
    const ability: Ability = {
      id: "x",
      trigger: { kind: "Activated", energyCost: 1 },
      action: [],
      usageLimit: "oncePerTurn",
    };
    let instance = recordAbilityUsage(baseInstance, ability, 3);
    instance = recordAbilityUsage(instance, ability, 4); // used again on turn 4
    expect(instance.abilityUsage?.x).toEqual({ count: 1, lastTurnNumber: 4 }); // not 2 — turn 3's use doesn't carry over
    expect(isUsageAvailable(instance, ability, 4)).toBe(false);
    expect(isUsageAvailable(instance, ability, 5)).toBe(true);
  });

  it("two DIFFERENT abilities on the same instance track independently — using one doesn't affect the other", () => {
    const abilityA: Ability = { id: "abilityA", trigger: { kind: "EtB" }, action: [], usageLimit: "oncePerGame" };
    const abilityB: Ability = { id: "abilityB", trigger: { kind: "Fall" }, action: [], usageLimit: "oncePerGame" };
    const instance = recordAbilityUsage(baseInstance, abilityA, 1);
    expect(isUsageAvailable(instance, abilityA, 1)).toBe(false); // used up
    expect(isUsageAvailable(instance, abilityB, 1)).toBe(true); // untouched — the game designer's specific concern
  });

  it("compound limits are treated as always-available (undefined semantics — spec §9) rather than guessed", () => {
    const ability: Ability = {
      id: "x",
      trigger: { kind: "EtB" },
      action: [],
      usageLimit: { compound: ["oncePerGame", "oncePerTurn"] },
    };
    const used = recordAbilityUsage(baseInstance, ability, 1);
    expect(isUsageAvailable(used, ability, 1)).toBe(true);
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
