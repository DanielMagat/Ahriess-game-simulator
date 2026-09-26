// Turn/phase state machine — see GAME_ENGINE_SPEC.md §6.
//
// Wires StartPhase -> MainPhase -> Repositioning -> TrapPlacement -> TrapResolution
// -> Damage -> EndPhase -> (next turn's) StartPhase together. Reuses the generic
// priority-window primitive for the three alternating-action phases, and the
// already-built combat resolver for Damage.
//
// Scope note: this module owns CONTROL FLOW (whose turn is it, which phase are we in,
// is this action legal right now, what happens when it resolves) — it does not know
// what a card, ability, or trap actually *does*. That's the ability-resolution engine,
// the next slice of work. Anywhere this module would need that knowledge, it calls out
// to a hook instead, the same pattern combatResolution.ts uses for triggers/statics.

import type { QueuedAbility } from "../types/abilities.js";
import type { Phase } from "../types/state.js";
import {
  PlayerId,
  PriorityWindowState,
  startPriorityWindow,
  isWindowComplete,
  afterAction,
  afterPass,
} from "./priorityWindow.js";
import { resolveLaneCombat, CombatUnit, LaneCombatHooks, CombatEvent } from "../combat/combatResolution.js";

// Re-exported so existing callers importing MatchPhase from here still work — the
// canonical definition now lives in types/state.ts (it was previously duplicated
// here under a different name, "MatchPhase" vs. "Phase"; consolidated to one).
export type MatchPhase = Phase;

type InfluenceColor = "E" | "S" | "I" | "B";

/** A trap sitting in the single global stack, tagged with which lane it was set to
 *  — it still resolves *in* that lane, it just doesn't get its own per-lane
 *  ordering. `instanceId` is the physical trap card itself (needed so it can be
 *  moved to the graveyard etc. once resolved); `trap` is the snapshot of what it
 *  does, locked in at the moment it was set — see spec §7. */
export interface QueuedTrap {
  laneId: string;
  instanceId: string;
  trap: QueuedAbility;
}

export type TrapResolutionOutcome = { status: "resolved" } | { status: "needsDecision"; reason: string };

export interface TurnMachineState {
  turnNumber: number;
  phase: MatchPhase;
  /** Whoever's turn it nominally is (for SoT/EoT bookkeeping) — distinct from priority. */
  activePlayerId: PlayerId;
  playerIds: [PlayerId, PlayerId];
  attackTokenHolderId: PlayerId;
  attackTokenSpentThisTurn: boolean;
  priorityWindow: PriorityWindowState;
  /** Set once combat is initiated; Repositioning and Trap Placement both start with
   *  whoever initiated. Cleared at the start of each new turn. */
  combatInitiatorId?: PlayerId;
  /** Granted fresh (equal to the current turn number) at the start of Repositioning. */
  repositioningCharges: Record<PlayerId, number>;
  laneIds: string[];
  /** Single global stack across ALL lanes — traps are always set to a specific lane,
   *  but resolve in one shared LIFO order regardless of which lane they target. */
  globalTrapStack: QueuedTrap[];
  /** StartPhase/EndPhase are simultaneous-decision phases, not alternating-priority
   *  ones — both players act independently, in either order, and the phase advances
   *  once BOTH have submitted. These track who's submitted so far this phase. */
  pendingInfluenceChoices: Partial<Record<PlayerId, InfluenceColor>>;
  pendingDiscards: Partial<Record<PlayerId, string[]>>;
}

export type StartPhaseAction = { kind: "chooseInfluence"; color: InfluenceColor };

export type MainPhaseAction =
  | { kind: "playCard"; instanceId: string }
  | { kind: "activateAbility"; abilityId: string }
  | { kind: "initiateCombat" }
  | { kind: "pass" };

export type RepositioningAction = { kind: "moveUnit"; instanceId: string; toLaneId: string } | { kind: "pass" };

export type TrapPlacementAction = { kind: "setTrap"; instanceId: string; laneId: string } | { kind: "pass" };

export type EndPhaseAction = { kind: "discard"; instanceIds: string[] };

export type PhaseAction =
  StartPhaseAction | MainPhaseAction | RepositioningAction | TrapPlacementAction | EndPhaseAction;

export type TurnMachineEvent =
  | { type: "actionRejected"; playerId: PlayerId; reason: string }
  | { type: "influenceChosen"; playerId: PlayerId; color: InfluenceColor }
  | { type: "cardPlayed"; playerId: PlayerId; instanceId: string }
  | { type: "abilityActivated"; playerId: PlayerId; abilityId: string }
  | { type: "combatInitiated"; initiatorId: PlayerId }
  | { type: "unitMoved"; playerId: PlayerId; instanceId: string; toLaneId: string; chargeCost: number }
  | { type: "trapSet"; playerId: PlayerId; instanceId: string; laneId: string }
  | { type: "trapResolved"; laneId: string; instanceId: string }
  | { type: "trapResolutionBlocked"; laneId: string; instanceId: string; reason: string }
  | { type: "laneCombatEvents"; laneId: string; events: CombatEvent[] }
  | { type: "discarded"; playerId: PlayerId; instanceIds: string[] }
  | { type: "turnEnded"; nextTurnNumber: number; nextAttackTokenHolderId: PlayerId }
  | { type: "phaseChanged"; from: MatchPhase; to: MatchPhase }
  | { type: "attackTokenSpent"; playerId: PlayerId }
  | { type: "priorityPassed"; to: PlayerId };

export interface TurnMachineHooks {
  /** Domain legality the phase machine can't determine on its own (energy cost, hand
   *  contents, etc. — the ability/cost system isn't built yet). Default-approve if
   *  omitted, so this module is usable standalone in tests. */
  isLegalPlay?(playerId: PlayerId, action: MainPhaseAction): boolean;
  isLegalDiscard?(playerId: PlayerId, instanceIds: string[]): boolean;
  /**
   * Actually resolving a trap's effect — stubbed until the ability engine exists.
   * Called once per trap, in LIFO order, across the whole board (not per lane).
   *
   * A trap's OWN choices are never made here — per spec §7, if a trap's ability
   * needs a player choice, that choice is made when the trap is SET (queue time),
   * producing a `locked` QueuedAbility; there's nothing left to decide by the time
   * this hook runs. `needsDecision` exists for a different, very real case: this
   * trap's (already fully-determined) effect can itself cause something else to
   * trigger — e.g. destroying a unit that has "Fall: put a +1/+1 counter on an
   * allied unit here," which is its own ability with its own player choice, fired
   * as a side effect of resolving THIS trap, not the trap's own targeting.
   *
   * When that happens, this hook returns `{ status: "needsDecision" }` and the turn
   * machine halts trap resolution entirely: it stays in TrapResolution, does NOT
   * pop this trap off the stack (so nothing is skipped or double-applied), and does
   * NOT advance to Damage. The harder part is on this hook's future implementation,
   * not the turn machine: resuming correctly means finishing the interrupted
   * trigger (queueing/resolving Fall with whatever the player picked) WITHOUT
   * re-running the part of this trap's own effect that already completed (the
   * destroy already happened — it can't happen again on resume). That resumable-
   * partial-execution behavior is the decision-checkpoint mechanism's job once it
   * exists (spec §7); this hook's contract just needs to support being re-invoked
   * for the same still-on-the-stack trap correctly, not assume every trap resolves
   * in one uninterrupted synchronous pass.
   * Omit the hook (or always return "resolved") for now — it's what every current
   * test does, since no trap effect exists yet that actually triggers something
   * needing a decision.
   */
  resolveTrapEffect?(trap: QueuedAbility, laneId: string, instanceId: string): TrapResolutionOutcome;
  /** Supplies this lane's two sides for Damage phase resolution, and the callbacks
   *  resolveLaneCombat itself needs. See combatResolution.ts. */
  getLaneCombatSetup(laneId: string): {
    sideA: CombatUnit[];
    sideB: CombatUnit[];
    hooks: LaneCombatHooks;
  };
  /** Agile N and similar keywords will eventually modify this — defaults to 1. */
  chargeCostForMove?(instanceId: string, toLaneId: string): number;
  /**
   * Whether moving this unit to this specific lane is currently legal — in
   * practice, whether `toLaneId` is in `getEffectiveAdjacentLanes(lanes,
   * currentLaneOf(instanceId))` (resolution/lanes.ts), which accounts for
   * deactivated lanes being skipped over. Omitted (like every other hook here)
   * means no check is performed — safe for unit-testing the phase machine in
   * isolation, but real integration should always provide this once MatchState
   * is wired in; without it, `submitRepositioningAction` would accept any
   * `toLaneId` at all, adjacent or not.
   */
  isLegalRepositionDestination?(instanceId: string, toLaneId: string): boolean;
}

export function createTurnMachine(params: {
  turnNumber: number;
  activePlayerId: PlayerId;
  attackTokenHolderId: PlayerId;
  otherPlayerId: PlayerId;
  laneIds: string[];
}): TurnMachineState {
  return {
    turnNumber: params.turnNumber,
    phase: "StartPhase",
    activePlayerId: params.activePlayerId,
    playerIds: [params.attackTokenHolderId, params.otherPlayerId],
    attackTokenHolderId: params.attackTokenHolderId,
    attackTokenSpentThisTurn: false,
    // Not used during StartPhase itself (that's a simultaneous-decision phase, not
    // priority-gated) — pre-set here so it's ready the instant MainPhase begins.
    priorityWindow: startPriorityWindow(params.attackTokenHolderId),
    repositioningCharges: {
      [params.attackTokenHolderId]: 0,
      [params.otherPlayerId]: 0,
    },
    laneIds: params.laneIds,
    globalTrapStack: [],
    pendingInfluenceChoices: {},
    pendingDiscards: {},
  };
}

function otherPlayer(state: TurnMachineState, playerId: PlayerId): PlayerId {
  return state.playerIds.find((id) => id !== playerId)!;
}

function canPassMainPhase(state: TurnMachineState, playerId: PlayerId): boolean {
  // The attack-token holder cannot pass until the token is spent — this is what
  // guarantees at least one combat per turn. See spec §3.
  if (playerId === state.attackTokenHolderId && !state.attackTokenSpentThisTurn) return false;
  return true;
}

function changePhase(state: TurnMachineState, to: MatchPhase, events: TurnMachineEvent[]): TurnMachineState {
  events.push({ type: "phaseChanged", from: state.phase, to });
  return { ...state, phase: to };
}

/**
 * Resolves the single global trap stack, LIFO — last trap set, anywhere on the
 * board, resolves first, regardless of which lane it was set to. Trap effect
 * execution itself is a hook (ability engine, next slice).
 *
 * Peeks before popping: a trap is only removed from the stack once it's actually
 * resolved. If a trap reports `needsDecision`, the loop stops immediately with
 * that trap (and everything below it) still on the stack, `blocked: true`, and no
 * further trap or the Damage phase is touched — see resolveTrapEffect's doc
 * comment on TurnMachineHooks for why. Safe to call again later with the same
 * (still-blocked) state once resumption exists; it'll re-attempt the same trap
 * from the top rather than skip it.
 */
function resolveAllTraps(
  state: TurnMachineState,
  hooks: TurnMachineHooks,
  events: TurnMachineEvent[]
): { state: TurnMachineState; blocked: boolean } {
  const stack = [...state.globalTrapStack];
  while (stack.length > 0) {
    const queued = stack[stack.length - 1]; // peek: LIFO, last set resolves first
    const outcome: TrapResolutionOutcome = hooks.resolveTrapEffect?.(queued.trap, queued.laneId, queued.instanceId) ?? {
      status: "resolved",
    };
    if (outcome.status === "needsDecision") {
      events.push({
        type: "trapResolutionBlocked",
        laneId: queued.laneId,
        instanceId: queued.instanceId,
        reason: outcome.reason,
      });
      return { state: { ...state, globalTrapStack: stack }, blocked: true };
    }
    stack.pop(); // only now, having actually resolved, is it safe to remove
    events.push({ type: "trapResolved", laneId: queued.laneId, instanceId: queued.instanceId });
  }
  return { state: { ...state, globalTrapStack: stack }, blocked: false };
}

/** Runs Damage phase across every lane, left to right, using the already-built
 *  combat resolver for each. */
function resolveDamagePhase(state: TurnMachineState, hooks: TurnMachineHooks, events: TurnMachineEvent[]): void {
  for (const laneId of state.laneIds) {
    const { sideA, sideB, hooks: laneHooks } = hooks.getLaneCombatSetup(laneId);
    const laneEvents = resolveLaneCombat(sideA, sideB, laneHooks);
    events.push({ type: "laneCombatEvents", laneId, events: laneEvents });
  }
}

export function submitAction(
  state: TurnMachineState,
  playerId: PlayerId,
  action: PhaseAction,
  hooks: TurnMachineHooks
): { state: TurnMachineState; events: TurnMachineEvent[] } {
  const events: TurnMachineEvent[] = [];

  // StartPhase and EndPhase are simultaneous-decision phases: both players act
  // independently, in either order, not gated by the priorityWindow at all — so
  // they're routed BEFORE the priority check below, which doesn't apply to them.
  if (state.phase === "StartPhase") {
    return submitStartPhaseAction(state, playerId, action as StartPhaseAction, events);
  }
  if (state.phase === "EndPhase") {
    return submitEndPhaseAction(state, playerId, action as EndPhaseAction, hooks, events);
  }

  if (playerId !== state.priorityWindow.priorityPlayerId) {
    events.push({ type: "actionRejected", playerId, reason: "not this player's priority" });
    return { state, events };
  }

  if (state.phase === "MainPhase") {
    return submitMainPhaseAction(state, playerId, action as MainPhaseAction, hooks, events);
  } else if (state.phase === "Repositioning") {
    return submitRepositioningAction(state, playerId, action as RepositioningAction, hooks, events);
  } else if (state.phase === "TrapPlacement") {
    return submitTrapPlacementAction(state, playerId, action as TrapPlacementAction, hooks, events);
  }

  events.push({ type: "actionRejected", playerId, reason: `no player actions are legal during ${state.phase}` });
  return { state, events };
}

function submitStartPhaseAction(
  state: TurnMachineState,
  playerId: PlayerId,
  action: StartPhaseAction,
  events: TurnMachineEvent[]
): { state: TurnMachineState; events: TurnMachineEvent[] } {
  const pendingInfluenceChoices = { ...state.pendingInfluenceChoices, [playerId]: action.color };
  events.push({ type: "influenceChosen", playerId, color: action.color });
  let next: TurnMachineState = { ...state, pendingInfluenceChoices };

  // Draw 3 / gain+refill energy are automatic (no decision) and depend on deck/hand
  // state this module doesn't track yet — left to a future hook alongside the
  // ability engine, same as SoT triggers needing target selection.
  if (state.playerIds.every((id) => pendingInfluenceChoices[id] !== undefined)) {
    next = { ...next, priorityWindow: startPriorityWindow(next.attackTokenHolderId) };
    next = changePhase(next, "MainPhase", events);
  }
  return { state: next, events };
}

function submitEndPhaseAction(
  state: TurnMachineState,
  playerId: PlayerId,
  action: EndPhaseAction,
  hooks: TurnMachineHooks,
  events: TurnMachineEvent[]
): { state: TurnMachineState; events: TurnMachineEvent[] } {
  if (hooks.isLegalDiscard && !hooks.isLegalDiscard(playerId, action.instanceIds)) {
    events.push({ type: "actionRejected", playerId, reason: "illegal discard" });
    return { state, events };
  }
  const pendingDiscards = { ...state.pendingDiscards, [playerId]: action.instanceIds };
  events.push({ type: "discarded", playerId, instanceIds: action.instanceIds });
  let next: TurnMachineState = { ...state, pendingDiscards };

  if (state.playerIds.every((id) => pendingDiscards[id] !== undefined)) {
    const nextTokenHolder = otherPlayer(next, next.attackTokenHolderId); // alternates each turn
    const nextTurnNumber = next.turnNumber + 1;
    events.push({ type: "turnEnded", nextTurnNumber, nextAttackTokenHolderId: nextTokenHolder });
    next = {
      ...next,
      turnNumber: nextTurnNumber,
      activePlayerId: nextTokenHolder,
      attackTokenHolderId: nextTokenHolder,
      attackTokenSpentThisTurn: false,
      combatInitiatorId: undefined,
      repositioningCharges: { [next.playerIds[0]]: 0, [next.playerIds[1]]: 0 },
      pendingInfluenceChoices: {},
      pendingDiscards: {},
    };
    next = changePhase(next, "StartPhase", events);
  }
  return { state: next, events };
}

function submitMainPhaseAction(
  state: TurnMachineState,
  playerId: PlayerId,
  action: MainPhaseAction,
  hooks: TurnMachineHooks,
  events: TurnMachineEvent[]
): { state: TurnMachineState; events: TurnMachineEvent[] } {
  const other = otherPlayer(state, playerId);

  if (action.kind === "pass") {
    if (!canPassMainPhase(state, playerId)) {
      events.push({ type: "actionRejected", playerId, reason: "attack token holder cannot pass until spent" });
      return { state, events };
    }
    const nextWindow = afterPass(state.priorityWindow, other);
    events.push({ type: "priorityPassed", to: other });
    let next = { ...state, priorityWindow: nextWindow };
    if (isWindowComplete(nextWindow)) {
      next = changePhase(next, "EndPhase", events);
    }
    return { state: next, events };
  }

  if (action.kind === "initiateCombat") {
    if (playerId !== state.attackTokenHolderId || state.attackTokenSpentThisTurn) {
      events.push({ type: "actionRejected", playerId, reason: "no unspent attack token" });
      return { state, events };
    }
    events.push({ type: "combatInitiated", initiatorId: playerId });
    events.push({ type: "attackTokenSpent", playerId });
    const next: TurnMachineState = {
      ...state,
      attackTokenSpentThisTurn: true,
      combatInitiatorId: playerId,
      priorityWindow: startPriorityWindow(playerId), // initiator repositions/traps first
      repositioningCharges: { [playerId]: state.turnNumber, [other]: state.turnNumber },
    };
    return { state: changePhase(next, "Repositioning", events), events };
  }

  // playCard / activateAbility — legality beyond "is it my priority" is a hook,
  // since energy/hand/cost checks aren't built yet.
  if (hooks.isLegalPlay && !hooks.isLegalPlay(playerId, action)) {
    events.push({ type: "actionRejected", playerId, reason: "illegal play" });
    return { state, events };
  }
  if (action.kind === "playCard") events.push({ type: "cardPlayed", playerId, instanceId: action.instanceId });
  if (action.kind === "activateAbility")
    events.push({ type: "abilityActivated", playerId, abilityId: action.abilityId });

  const nextWindow = afterAction(state.priorityWindow, other);
  events.push({ type: "priorityPassed", to: other });
  return { state: { ...state, priorityWindow: nextWindow }, events };
}

function submitRepositioningAction(
  state: TurnMachineState,
  playerId: PlayerId,
  action: RepositioningAction,
  hooks: TurnMachineHooks,
  events: TurnMachineEvent[]
): { state: TurnMachineState; events: TurnMachineEvent[] } {
  const other = otherPlayer(state, playerId);

  if (action.kind === "pass") {
    const nextWindow = afterPass(state.priorityWindow, other);
    events.push({ type: "priorityPassed", to: other });
    let next: TurnMachineState = { ...state, priorityWindow: nextWindow };
    if (isWindowComplete(nextWindow)) {
      next = { ...next, priorityWindow: startPriorityWindow(state.combatInitiatorId!) };
      next = changePhase(next, "TrapPlacement", events);
    }
    return { state: next, events };
  }

  // moveUnit
  if (hooks.isLegalRepositionDestination && !hooks.isLegalRepositionDestination(action.instanceId, action.toLaneId)) {
    events.push({ type: "actionRejected", playerId, reason: "not a legal reposition destination" });
    return { state, events };
  }
  const cost = hooks.chargeCostForMove?.(action.instanceId, action.toLaneId) ?? 1;
  const available = state.repositioningCharges[playerId] ?? 0;
  if (available < cost) {
    events.push({ type: "actionRejected", playerId, reason: "not enough repositioning charges" });
    return { state, events };
  }
  events.push({
    type: "unitMoved",
    playerId,
    instanceId: action.instanceId,
    toLaneId: action.toLaneId,
    chargeCost: cost,
  });
  const nextWindow = afterAction(state.priorityWindow, other);
  events.push({ type: "priorityPassed", to: other });
  const next: TurnMachineState = {
    ...state,
    priorityWindow: nextWindow,
    repositioningCharges: { ...state.repositioningCharges, [playerId]: available - cost },
  };
  return { state: next, events };
}

function submitTrapPlacementAction(
  state: TurnMachineState,
  playerId: PlayerId,
  action: TrapPlacementAction,
  hooks: TurnMachineHooks,
  events: TurnMachineEvent[]
): { state: TurnMachineState; events: TurnMachineEvent[] } {
  const other = otherPlayer(state, playerId);

  if (action.kind === "pass") {
    const nextWindow = afterPass(state.priorityWindow, other);
    events.push({ type: "priorityPassed", to: other });
    let next: TurnMachineState = { ...state, priorityWindow: nextWindow };
    if (isWindowComplete(nextWindow)) {
      next = changePhase(next, "TrapResolution", events);
      const trapResult = resolveAllTraps(next, hooks, events);
      next = trapResult.state;
      if (trapResult.blocked) {
        // Stay in TrapResolution — do NOT enter Damage while a trap is still
        // pending player input. Resuming this is the decision-checkpoint
        // mechanism's job (spec §7, not yet built); this just guarantees Damage
        // is never reached in the meantime.
        return { state: next, events };
      }
      next = changePhase(next, "Damage", events);
      resolveDamagePhase(next, hooks, events);
      const nonInitiator = otherPlayer(next, next.combatInitiatorId!);
      next = {
        ...next,
        priorityWindow: startPriorityWindow(nonInitiator), // non-initiator gets priority back
      };
      next = changePhase(next, "MainPhase", events);
    }
    return { state: next, events };
  }

  // setTrap — appended to the single global stack, tagged with its lane.
  const globalTrapStack: QueuedTrap[] = [
    ...state.globalTrapStack,
    {
      laneId: action.laneId,
      instanceId: action.instanceId,
      trap: {
        // Placeholder until card loading exists to resolve a real ability id from
        // this instance's definition — see TurnMachineHooks.resolveTrapEffect.
        sourceAbilityId: action.instanceId,
        controllerId: playerId,
        targeting: { kind: "none" }, // real target-snapshotting is part of the ability engine, next slice
        action: { hook: "unresolved" }, // effect execution is part of the ability engine, next slice
      },
    },
  ];
  events.push({ type: "trapSet", playerId, instanceId: action.instanceId, laneId: action.laneId });
  const nextWindow = afterAction(state.priorityWindow, other);
  events.push({ type: "priorityPassed", to: other });
  return { state: { ...state, globalTrapStack, priorityWindow: nextWindow }, events };
}
