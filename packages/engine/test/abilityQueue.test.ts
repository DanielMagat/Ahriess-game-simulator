import { describe, it, expect } from "vitest";
import { queueAbility, resolveQueuedAbility } from "../src/resolution/abilityQueue.js";
import { executeAction } from "../src/resolution/actions.js";
import { makeMatchState, addUnit, TestStatsRegistry } from "./helpers/fixtures.js";

const ctx = { controllerId: "P1", sourceLaneId: "lane1", sourceInstanceId: "trapCard" };

describe("queueAbility", () => {
  it("locks in candidates at queue time for a fully-automatic TargetSpec", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "enemy1", controllerId: "P2", laneId: "lane1", power: 1, toughness: 3 });

    const result = queueAbility(
      state,
      {
        trigger: { kind: "Custom", hook: "trapSet" },
        target: { allegiance: "enemy" },
        action: [{ kind: "dealDamage", amount: 2, target: {} }],
      },
      ctx
    );
    expect(result.status).toBe("queued");
    if (result.status === "queued") {
      expect(result.queued.lockedTargets).toEqual([{ objectId: "enemy1" }]);
      expect(result.queued.controllerId).toBe("P1");
    }
  });

  it("an ability with no target field queues with empty locked targets", () => {
    const state = makeMatchState(["lane1"]);
    const result = queueAbility(
      state,
      { trigger: { kind: "Custom", hook: "x" }, action: [{ kind: "draw", count: 1 }] },
      ctx
    );
    expect(result.status).toBe("queued");
    if (result.status === "queued") expect(result.queued.lockedTargets).toEqual([]);
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

describe("resolveQueuedAbility — the actual §7 failure modes this design exists to prevent", () => {
  it("a locked target that died before resolution is dropped, not an error, and the action simply does nothing to it", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, { instanceId: "enemy1", controllerId: "P2", laneId: "lane1", power: 1, toughness: 3 });

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

    // Something else (a different queued ability resolving first) kills the target
    // before THIS one gets its turn to resolve.
    const afterDeath = executeAction(state, { kind: "destroy", target: {} }, ctx, [{ objectId: "enemy1" }]).state;
    expect(afterDeath.units.enemy1).toBeUndefined();

    const result = resolveQueuedAbility(afterDeath, queueResult.queued, ctx, reg);
    expect(result.events).toContainEqual({ type: "targetNoLongerValid", target: "enemy1" });
    // No damage event for a target that's already gone, and no crash.
    expect(result.events.filter((e) => e.type === "damage")).toHaveLength(0);
  });

  it("a NEW object that appears after queueing does NOT retroactively become a target of an already-queued ability", () => {
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
    expect(queueResult.queued.lockedTargets).toEqual([{ objectId: "enemy1" }]);

    // A second enemy unit shows up in the same lane before this ability resolves
    // (e.g. summoned by something else that resolved first in the queue).
    const withNewcomer = addUnit(state, reg, {
      instanceId: "enemy2",
      controllerId: "P2",
      laneId: "lane1",
      power: 1,
      toughness: 3,
    });

    const result = resolveQueuedAbility(withNewcomer, queueResult.queued, ctx, reg);
    // Only the originally-locked target takes damage — the newcomer, despite
    // matching "each enemy unit here" if the query were re-run, does not.
    expect(result.state.units.enemy1.damage).toBe(2);
    expect(result.state.units.enemy2.damage).toBe(0);
    expect(result.events.filter((e) => e.type === "damage")).toHaveLength(1);
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
    // Lethal damage triggers the state-based death sweep as part of resolution.
    expect(result.events).toContainEqual({ type: "unitDied", instanceId: "enemy1" });
    expect(result.state.units.enemy1).toBeUndefined();
    expect(result.state.players.P2.zones.graveyard).toEqual(["enemy1"]);
  });

  it("a trap-stack scenario: an earlier-resolving trap destroys the shared target before a later one — mirrors real LIFO resolution order", () => {
    const reg = new TestStatsRegistry();
    let state = makeMatchState(["lane1"]);
    state = addUnit(state, reg, {
      instanceId: "sharedTarget",
      controllerId: "P2",
      laneId: "lane1",
      power: 1,
      toughness: 3,
    });

    // Both traps were set while sharedTarget was still alive, so both lock it in.
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

    const afterA = resolveQueuedAbility(afterB.state, trapA.queued, ctx, reg);
    expect(afterA.events).toContainEqual({ type: "targetNoLongerValid", target: "sharedTarget" });
    expect(afterA.events.filter((e) => e.type === "damage")).toHaveLength(0);
  });
});
