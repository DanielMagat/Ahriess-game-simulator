import { describe, it, expect } from "vitest";
import { createTurnMachine, submitAction, TurnMachineHooks } from "../src/phase/turnMachine.js";
import { CombatUnit } from "../src/combat/combatResolution.js";

function makeUnit(id: string): CombatUnit {
  return { id, power: 1, toughness: 3, frozen: false, hasFirstStrike: false };
}

function noopLaneHooks() {
  return {
    dealDamageToBase() {},
    isLaneDeactivated: () => false,
    drainTriggersAndStatics() {},
  };
}

describe("turnMachine — full turn cycle", () => {
  it("runs a complete turn end to end: start-phase influence choice, forced combat, repositioning charges, trap LIFO order, multi-lane damage, priority handoff, end-phase discard, and rolls into the next turn's start phase with the token alternated", () => {
    const P1 = "P1";
    const P2 = "P2";

    let state = createTurnMachine({
      turnNumber: 3,
      activePlayerId: P1,
      attackTokenHolderId: P1,
      otherPlayerId: P2,
      laneIds: ["lane1", "lane2"],
    });
    expect(state.phase).toBe("StartPhase");

    const trapResolveOrder: string[] = [];
    const lane1UnitX = makeUnit("X");
    const lane1UnitY = makeUnit("Y");

    const hooks: TurnMachineHooks = {
      resolveTrapEffect(trap, laneId, instanceId) {
        trapResolveOrder.push(instanceId);
      },
      getLaneCombatSetup(laneId) {
        if (laneId === "lane1") {
          return { sideA: [lane1UnitX], sideB: [lane1UnitY], hooks: noopLaneHooks() };
        }
        return { sideA: [], sideB: [], hooks: noopLaneHooks() };
      },
    };

    // --- StartPhase: both players choose influence independently, not priority-gated ---
    let result = submitAction(state, P2, { kind: "chooseInfluence", color: "S" }, hooks);
    state = result.state;
    expect(state.phase).toBe("StartPhase"); // only one of two has chosen so far
    result = submitAction(state, P1, { kind: "chooseInfluence", color: "E" }, hooks);
    state = result.state;
    expect(state.phase).toBe("MainPhase"); // both chosen -> auto-advances
    expect(state.priorityWindow.priorityPlayerId).toBe(P1); // token holder gets priority first

    // --- MainPhase: P1 (token holder) cannot pass, must act ---
    result = submitAction(state, P1, { kind: "pass" }, hooks);
    expect(result.events).toContainEqual({
      type: "actionRejected",
      playerId: P1,
      reason: "attack token holder cannot pass until spent",
    });

    result = submitAction(state, P1, { kind: "playCard", instanceId: "someInstance" }, hooks);
    state = result.state;
    expect(state.priorityWindow.priorityPlayerId).toBe(P2);

    result = submitAction(state, P2, { kind: "pass" }, hooks);
    state = result.state;
    expect(state.priorityWindow.priorityPlayerId).toBe(P1);
    expect(state.priorityWindow.consecutivePasses).toBe(1);

    // P1 still can't pass — the only way forward is to act, and eventually initiate combat.
    result = submitAction(state, P1, { kind: "pass" }, hooks);
    expect(result.events).toContainEqual({
      type: "actionRejected",
      playerId: P1,
      reason: "attack token holder cannot pass until spent",
    });

    result = submitAction(state, P1, { kind: "initiateCombat" }, hooks);
    state = result.state;
    expect(state.phase).toBe("Repositioning");
    expect(state.attackTokenSpentThisTurn).toBe(true);
    expect(state.combatInitiatorId).toBe(P1);
    expect(state.repositioningCharges).toEqual({ P1: 3, P2: 3 }); // equal to turnNumber
    expect(state.priorityWindow.priorityPlayerId).toBe(P1); // initiator goes first

    // --- Repositioning: charges are spent per move ---
    result = submitAction(state, P1, { kind: "moveUnit", instanceId: "X", toLaneId: "lane2" }, hooks);
    state = result.state;
    expect(state.repositioningCharges.P1).toBe(2);
    expect(state.priorityWindow.priorityPlayerId).toBe(P2);

    result = submitAction(state, P2, { kind: "pass" }, hooks);
    state = result.state;
    result = submitAction(state, P1, { kind: "pass" }, hooks);
    state = result.state;
    expect(state.phase).toBe("TrapPlacement");
    expect(state.priorityWindow.priorityPlayerId).toBe(P1); // initiator goes first again

    // --- Trap Placement: P1 sets to lane1, P2 sets to lane2 — different lanes, but
    //     P2's should STILL resolve first, since the stack is global, not per-lane ---
    result = submitAction(state, P1, { kind: "setTrap", instanceId: "P1trap", laneId: "lane1" }, hooks);
    state = result.state;
    result = submitAction(state, P2, { kind: "setTrap", instanceId: "P2trap", laneId: "lane2" }, hooks);
    state = result.state;

    result = submitAction(state, P1, { kind: "pass" }, hooks);
    state = result.state;
    result = submitAction(state, P2, { kind: "pass" }, hooks);
    state = result.state;

    // Passing both here should have cascaded: trap resolution -> damage -> back to MainPhase.
    // Global stack, not per-lane: P2's trap (lane2, set last) resolves before P1's (lane1, set first).
    expect(trapResolveOrder).toEqual(["P2trap", "P1trap"]);
    expect(state.phase).toBe("MainPhase");
    expect(state.priorityWindow.priorityPlayerId).toBe(P2); // non-initiator gets priority back

    const laneCombatEntries = result.events.filter((e) => e.type === "laneCombatEvents");
    expect(laneCombatEntries).toHaveLength(2); // both lanes processed, left to right
    const lane1Result = laneCombatEntries.find((e: any) => e.laneId === "lane1") as any;
    expect(lane1Result.events).toContainEqual({ type: "mutualFight", a: "X", b: "Y" });

    // --- Token is spent now, so both players can pass; this ends MainPhase -> EndPhase ---
    result = submitAction(state, P2, { kind: "pass" }, hooks);
    state = result.state;
    expect(state.priorityWindow.consecutivePasses).toBe(1);
    result = submitAction(state, P1, { kind: "pass" }, hooks); // token holder CAN pass now
    state = result.state;
    expect(state.phase).toBe("EndPhase");

    // --- EndPhase: both players discard independently, not priority-gated ---
    result = submitAction(state, P1, { kind: "discard", instanceIds: [] }, hooks);
    state = result.state;
    expect(state.phase).toBe("EndPhase"); // only one of two so far
    result = submitAction(state, P2, { kind: "discard", instanceIds: ["someExcessCard"] }, hooks);
    state = result.state;

    // Both discarded -> rolls into the next turn's StartPhase, token alternated, turn incremented.
    expect(state.phase).toBe("StartPhase");
    expect(state.turnNumber).toBe(4);
    expect(state.attackTokenHolderId).toBe(P2);
    expect(state.attackTokenSpentThisTurn).toBe(false);
    expect(state.pendingInfluenceChoices).toEqual({});
  });

  it("rejects actions from a player who doesn't currently hold priority (during a priority-gated phase)", () => {
    const state = createTurnMachine({
      turnNumber: 1,
      activePlayerId: "P1",
      attackTokenHolderId: "P1",
      otherPlayerId: "P2",
      laneIds: ["lane1"],
    });
    const hooks: TurnMachineHooks = {
      getLaneCombatSetup: () => ({ sideA: [], sideB: [], hooks: noopLaneHooks() }),
    };
    // Advance out of StartPhase first, since it isn't priority-gated at all.
    let result = submitAction(state, "P1", { kind: "chooseInfluence", color: "E" }, hooks);
    let next = result.state;
    result = submitAction(next, "P2", { kind: "chooseInfluence", color: "S" }, hooks);
    next = result.state;
    expect(next.phase).toBe("MainPhase");

    result = submitAction(next, "P2", { kind: "pass" }, hooks);
    expect(result.events).toContainEqual({
      type: "actionRejected",
      playerId: "P2",
      reason: "not this player's priority",
    });
    expect(result.state).toBe(next); // unchanged
  });

  it("halts in TrapResolution — never enters Damage — while a trap reports needsDecision, and doesn't lose the blocked trap", () => {
    const P1 = "P1";
    const P2 = "P2";
    let state = createTurnMachine({
      turnNumber: 1,
      activePlayerId: P1,
      attackTokenHolderId: P1,
      otherPlayerId: P2,
      laneIds: ["lane1"],
    });

    let resolveCallCount = 0;
    const hooks: TurnMachineHooks = {
      resolveTrapEffect(_trap, _laneId, _instanceId) {
        resolveCallCount++;
        return { status: "needsDecision", reason: "choose one" };
      },
      getLaneCombatSetup: () => ({ sideA: [], sideB: [], hooks: noopLaneHooks() }),
    };

    let result = submitAction(state, P1, { kind: "chooseInfluence", color: "E" }, hooks);
    state = result.state;
    result = submitAction(state, P2, { kind: "chooseInfluence", color: "S" }, hooks);
    state = result.state;
    result = submitAction(state, P1, { kind: "initiateCombat" }, hooks);
    state = result.state;
    result = submitAction(state, P1, { kind: "pass" }, hooks); // Repositioning: both pass
    state = result.state;
    result = submitAction(state, P2, { kind: "pass" }, hooks);
    state = result.state;
    expect(state.phase).toBe("TrapPlacement");

    result = submitAction(state, P1, { kind: "setTrap", instanceId: "trap1", laneId: "lane1" }, hooks);
    state = result.state;
    result = submitAction(state, P2, { kind: "pass" }, hooks);
    state = result.state;
    result = submitAction(state, P1, { kind: "pass" }, hooks); // both pass -> trap resolution kicks in

    state = result.state;
    // Blocked: stays in TrapResolution, never reaches Damage, the trap is still on
    // the stack (not silently dropped or double-consumed), and no laneCombatEvents
    // were emitted at all.
    expect(state.phase).toBe("TrapResolution");
    expect(state.globalTrapStack).toHaveLength(1);
    expect(state.globalTrapStack[0].instanceId).toBe("trap1");
    expect(result.events).toContainEqual({
      type: "trapResolutionBlocked",
      laneId: "lane1",
      instanceId: "trap1",
      reason: "choose one",
    });
    expect(result.events.some((e) => e.type === "laneCombatEvents")).toBe(false);
    expect(result.events.some((e) => e.type === "trapResolved")).toBe(false);
    expect(resolveCallCount).toBe(1);
  });

  it("StartPhase and EndPhase accept actions from either player regardless of priorityWindow state", () => {
    const state = createTurnMachine({
      turnNumber: 1,
      activePlayerId: "P1",
      attackTokenHolderId: "P1",
      otherPlayerId: "P2",
      laneIds: ["lane1"],
    });
    const hooks: TurnMachineHooks = {
      getLaneCombatSetup: () => ({ sideA: [], sideB: [], hooks: noopLaneHooks() }),
    };
    // priorityWindow says P1 has priority, but P2 should still be able to choose
    // influence in StartPhase — these phases aren't gated by priority at all.
    expect(state.priorityWindow.priorityPlayerId).toBe("P1");
    const result = submitAction(state, "P2", { kind: "chooseInfluence", color: "B" }, hooks);
    expect(result.events).toContainEqual({ type: "influenceChosen", playerId: "P2", color: "B" });
  });
});
