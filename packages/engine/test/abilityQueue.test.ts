import { describe, it, expect } from "vitest";
import { queueAbility, resolveQueuedAbility } from "../src/resolution/abilityQueue.js";
import { executeAction } from "../src/resolution/actions.js";
import { QueuedAbility } from "../src/types/abilities.js";
import { makeMatchState, addUnit, TestStatsRegistry } from "./helpers/fixtures.js";

const ctx = { controllerId: "P1", sourceLaneId: "lane1", sourceInstanceId: "trapCard" };

describe("queueAbility", () => {
  it("an automatic scope defers to a live query — nothing is locked in at queue time", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "enemy1", controllerId: "P2", laneId: "lane1", power: 1, toughness: 3 });

    const result = queueAbility(
      state,
      {
        trigger: { kind: "Custom", hook: "trapSet" },
        target: { allegiance: "enemy" }, // "each enemy unit here" — no playerChooses, fully automatic
        action: [{ kind: "dealDamage", amount: 2, target: {} }],
      },
      ctx
    );
    expect(result.status).toBe("queued");
    if (result.status === "queued") {
      // No candidates computed or locked here — just the spec, carried forward for
      // resolution to query live, later. See GAME_ENGINE_SPEC.md §7.
      expect(result.queued.targeting).toEqual({ kind: "liveScope", spec: { allegiance: "enemy" } });
      expect(result.queued.controllerId).toBe("P1");
    }
  });

  it("an ability with no target field queues with targeting: none", () => {
    const state = makeMatchState(["lane1"]);
    const result = queueAbility(
      state,
      { trigger: { kind: "Custom", hook: "x" }, action: [{ kind: "draw", count: 1 }] },
      ctx
    );
    expect(result.status).toBe("queued");
    if (result.status === "queued") expect(result.queued.targeting).toEqual({ kind: "none" });
  });

  it("player-chosen targeting blocks queueing with needsDecision rather than guessing", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "enemy1", controllerId: "P2", laneId: "lane1", power: 1, toughness: 3 });

    const result = queueAbility(
      state,
      {
        trigger: { kind: "Custom", hook: "trapSet" },
        target: { allegiance: "enemy", playerChooses: true },
        action: [{ kind: "dealDamage", amount: 2, target: {} }],
      },
      ctx
    );
    expect(result.status).toBe("needsDecision");
  });
});

describe("resolveQueuedAbility — locked (player-chosen) targeting: the §7 protection against board drift", () => {
  // The decision-checkpoint mechanism that would actually produce a `locked`
  // QueuedAbility from a real player choice isn't built yet (see queueAbility's
  // needsDecision case) — so these construct one directly, as if a player had
  // already made that choice when the ability was queued. That's exactly the
  // shape resolveQueuedAbility will receive once the real mechanism exists.
  function lockedAbility(targets: { objectId: string }[]): QueuedAbility {
    return {
      sourceAbilityId: "src",
      controllerId: "P1",
      targeting: { kind: "locked", targets, originalSelectionCriteria: { allegiance: "enemy" } },
      action: [{ kind: "dealDamage", amount: 2, target: {} }],
    };
  }

  it("a locked target that died before resolution is dropped, not an error, and the action simply does nothing to it", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "enemy1", controllerId: "P2", laneId: "lane1", power: 1, toughness: 3 });

    // Something else (a different queued ability resolving first) kills the target
    // before THIS one gets its turn to resolve.
    const afterDeath = executeAction(state, { kind: "destroy", target: {} }, ctx, [{ objectId: "enemy1" }]).state;
    expect(afterDeath.units.enemy1).toBeUndefined();

    const result = resolveQueuedAbility(afterDeath, lockedAbility([{ objectId: "enemy1" }]), ctx, reg);
    expect(result.events).toContainEqual({ type: "targetNoLongerValid", target: "enemy1" });
    // No damage event for a target that's already gone, and no crash.
    expect(result.events.filter((e) => e.type === "damage")).toHaveLength(0);
  });

  it("a NEW object that appears after queueing does NOT retroactively become a target of an already-locked ability", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "enemy1", controllerId: "P2", laneId: "lane1", power: 1, toughness: 3 });

    const locked = lockedAbility([{ objectId: "enemy1" }]); // as if the player chose enemy1 specifically

    // A second enemy unit shows up in the same lane before this ability resolves
    // (e.g. summoned by something else that resolved first in the queue).
    const withNewcomer = addUnit(state, reg, {
      instanceId: "enemy2",
      controllerId: "P2",
      laneId: "lane1",
      power: 1,
      toughness: 3,
    });

    const result = resolveQueuedAbility(withNewcomer, locked, ctx, reg);
    // Only the originally-chosen target takes damage — the newcomer, despite being
    // a valid enemy unit here, was never chosen, so it isn't retroactively included.
    expect(result.state.units.enemy1.damage).toBe(2);
    expect(result.state.units.enemy2.damage).toBe(0);
    expect(result.events.filter((e) => e.type === "damage")).toHaveLength(1);
  });

  it("happy path: a still-valid locked target takes the effect normally, including a follow-on death sweep", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "enemy1", controllerId: "P2", laneId: "lane1", power: 1, toughness: 2 });

    const locked: QueuedAbility = {
      sourceAbilityId: "src",
      controllerId: "P1",
      targeting: {
        kind: "locked",
        targets: [{ objectId: "enemy1" }],
        originalSelectionCriteria: { allegiance: "enemy" },
      },
      action: [{ kind: "dealDamage", amount: 5, target: {} }],
    };

    const result = resolveQueuedAbility(state, locked, ctx, reg);
    expect(result.events).toContainEqual({ type: "damage", target: "enemy1", amount: 5 });
    // Lethal damage triggers the state-based death sweep as part of resolution.
    expect(result.events).toContainEqual({ type: "unitDied", instanceId: "enemy1" });
    expect(result.state.units.enemy1).toBeUndefined();
    expect(result.state.players.P2.zones.graveyard).toEqual(["enemy1"]);
  });
});

describe("resolveQueuedAbility — liveScope (automatic) targeting: re-queried fresh at resolution, per §7", () => {
  it("a NEW object that appears after queueing DOES become a target — that's what 'live' means for an automatic scope", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "enemy1", controllerId: "P2", laneId: "lane1", power: 1, toughness: 3 });

    // "deal 2 damage to each enemy unit here" — only enemy1 exists right now.
    const queueResult = queueAbility(
      state,
      {
        trigger: { kind: "Custom", hook: "x" },
        target: { allegiance: "enemy" },
        action: [{ kind: "dealDamage", amount: 2, target: {} }],
      },
      ctx
    );
    if (queueResult.status !== "queued") throw new Error("expected queued");
    expect(queueResult.queued.targeting).toEqual({ kind: "liveScope", spec: { allegiance: "enemy" } });

    // A second enemy unit shows up in the same lane before this ability resolves.
    const withNewcomer = addUnit(state, reg, {
      instanceId: "enemy2",
      controllerId: "P2",
      laneId: "lane1",
      power: 1,
      toughness: 3,
    });

    const result = resolveQueuedAbility(withNewcomer, queueResult.queued, ctx, reg);
    // Both take damage — the live query re-runs "each enemy unit here" against the
    // board as it looks right now, and the newcomer genuinely matches.
    expect(result.state.units.enemy1.damage).toBe(2);
    expect(result.state.units.enemy2.damage).toBe(2);
    expect(result.events.filter((e) => e.type === "damage")).toHaveLength(2);
  });

  it("happy path: a still-valid target takes the effect normally, including a follow-on death sweep", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "enemy1", controllerId: "P2", laneId: "lane1", power: 1, toughness: 2 });

    const queueResult = queueAbility(
      state,
      {
        trigger: { kind: "Custom", hook: "x" },
        target: { allegiance: "enemy" },
        action: [{ kind: "dealDamage", amount: 5, target: {} }],
      },
      ctx
    );
    if (queueResult.status !== "queued") throw new Error("expected queued");

    const result = resolveQueuedAbility(state, queueResult.queued, ctx, reg);
    expect(result.events).toContainEqual({ type: "damage", target: "enemy1", amount: 5 });
    expect(result.events).toContainEqual({ type: "unitDied", instanceId: "enemy1" });
    expect(result.state.units.enemy1).toBeUndefined();
    expect(result.state.players.P2.zones.graveyard).toEqual(["enemy1"]);
  });

  it("a trap-stack scenario: an earlier-resolving trap destroys the shared target before a later one's live query runs — mirrors real LIFO resolution order", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, {
      instanceId: "sharedTarget",
      controllerId: "P2",
      laneId: "lane1",
      power: 1,
      toughness: 3,
    });

    // Both traps are automatic scopes ("each enemy unit here") — neither locks
    // anything at set/queue time, they just carry the spec forward.
    const trapB = queueAbility(
      state,
      {
        trigger: { kind: "Custom", hook: "trapB" },
        target: { allegiance: "enemy" },
        action: [{ kind: "destroy", target: {} }],
      },
      ctx
    );
    const trapA = queueAbility(
      state,
      {
        trigger: { kind: "Custom", hook: "trapA" },
        target: { allegiance: "enemy" },
        action: [{ kind: "dealDamage", amount: 2, target: {} }],
      },
      ctx
    );
    if (trapB.status !== "queued" || trapA.status !== "queued") throw new Error("expected both queued");

    // LIFO: trapB was set later, so it resolves first (matches turnMachine.ts's
    // global stack ordering — this test exercises resolution order directly rather
    // than going through the phase machine).
    const afterB = resolveQueuedAbility(state, trapB.queued, ctx, reg);
    expect(afterB.state.units.sharedTarget).toBeUndefined();

    // trapA's live query now runs against a board where sharedTarget is already
    // gone — it simply finds no candidates. No "targetNoLongerValid" event, because
    // nothing was locked to be found invalid in the first place; it's just an empty
    // live result, same as if the query had always come up empty.
    const afterA = resolveQueuedAbility(afterB.state, trapA.queued, ctx, reg);
    expect(afterA.events.filter((e) => e.type === "targetNoLongerValid")).toHaveLength(0);
    expect(afterA.events.filter((e) => e.type === "damage")).toHaveLength(0);
  });
});
