// Action execution — see GAME_ENGINE_SPEC.md §4. Implements a representative
// subset of the primitive list (dealDamage, heal, addCounter, removeCounter,
// buffStat, freeze, draw, destroy, sacrifice) rather than all of them — enough to
// exercise the target-snapshot machinery (abilityQueue.ts) meaningfully. The rest
// follow the same pattern once needed; nothing here is architecturally special
// about the ones chosen.

import type { MatchState, CardInstance } from "../types/state.js";
import type { Action, ObjectRef } from "../types/abilities.js";
import { counterSemantics, builtinCounterPolarity, BuiltinCounterName } from "../types/cards.js";
import { EffectContext } from "./targeting.js";
import { updateUnit, adjustCounter, activeCounters, moveFromBattlefieldToGraveyard } from "./stateHelpers.js";

export type ResolutionEvent = { type: string; [key: string]: unknown };

/**
 * Supplies base power/toughness for whatever a CardInstance's origin actually is —
 * injected rather than assumed, because computing it needs the card database, which
 * doesn't exist yet (roadmap: "card loading from data"). Tests supply a small fake;
 * real card loading supplies the real thing later without this module changing.
 */
export interface DefinitionLookup {
  getBaseStats(instance: CardInstance): { power?: number; toughness?: number };
}

export interface CurrentStats {
  power?: number;
  toughness?: number;
}

/** Base stats from the instance's definition, plus its active counters, plus any
 *  status-effect stat modifiers, minus battlefield damage — computed fresh, never
 *  cached, per the "derive, don't store" decision in BattlefieldUnit's design (§5). */
export function computeCurrentStats(
  state: MatchState,
  instanceId: string,
  definitions: DefinitionLookup
): CurrentStats {
  const instance = state.cardInstances[instanceId];
  const unit = state.units[instanceId];
  if (!instance || !unit) return {};

  let { power, toughness } = definitions.getBaseStats(instance);

  for (const counter of activeCounters(instance)) {
    if (counter.name === "+1/+1") {
      power = (power ?? 0) + counter.count;
      toughness = (toughness ?? 0) + counter.count;
    } else if (counter.name === "-1/-1") {
      power = (power ?? 0) - counter.count;
      toughness = (toughness ?? 0) - counter.count;
    }
  }

  for (const status of unit.statusEffects) {
    if (status.kind === "statModifier") {
      if (status.power) power = (power ?? 0) + status.power;
      if (status.toughness) toughness = (toughness ?? 0) + status.toughness;
    }
  }

  if (toughness !== undefined) toughness -= unit.damage;
  return { power, toughness };
}

/** Sweeps every battlefield unit for lethal toughness and moves any found to their
 *  controller's graveyard. Mirrors combatResolution.ts's pattern of emitting a
 *  death event and leaving cleanup to a distinct step, rather than dealDamage (or
 *  any other single action) trying to decide death inline — this way every action
 *  that could reduce toughness (damage, a -1/-1 debuff, counter removal) is checked
 *  the same way, once, rather than each needing its own death-detection logic.
 *  Called once after a queued ability's actions all run — see abilityQueue.ts. */
export function processStateBasedDeaths(
  state: MatchState,
  definitions: DefinitionLookup
): { state: MatchState; events: ResolutionEvent[] } {
  const events: ResolutionEvent[] = [];
  let next = state;
  for (const instanceId of Object.keys(next.units)) {
    const stats = computeCurrentStats(next, instanceId, definitions);
    if (stats.toughness !== undefined && stats.toughness <= 0) {
      next = moveFromBattlefieldToGraveyard(next, instanceId);
      events.push({ type: "unitDied", instanceId });
    }
  }
  return { state: next, events };
}

function dealDamageTo(state: MatchState, instanceId: string, amount: number): MatchState {
  return updateUnit(state, instanceId, (u) => ({ ...u, damage: u.damage + amount }));
}

function findCounter(state: MatchState, instanceId: string, counterName: BuiltinCounterName) {
  const instance = state.cardInstances[instanceId];
  if (!instance) return undefined;
  return activeCounters(instance).find((c) => c.name === counterName);
}

/**
 * Applies shield/plating mitigation before damage lands, mirroring combatResolution.ts's
 * applyDamage — see that file for the precedence rule (shield first, full negation;
 * plating second, reduces then depletes regardless). This is a separate implementation
 * rather than a shared one because this module operates on real MatchState/Counter[]
 * while combatResolution.ts deliberately stays decoupled from those types — see its
 * CombatUnit doc comment. Keep the two in sync if the mitigation rule ever changes.
 */
function applyMitigatedDamage(
  state: MatchState,
  instanceId: string,
  amount: number
): { state: MatchState; dealt: number; events: ResolutionEvent[] } {
  const events: ResolutionEvent[] = [];
  const shield = findCounter(state, instanceId, "shield");
  if (shield && shield.count > 0) {
    const next = adjustCounter(state, instanceId, "shield", -1, "beneficial", "builtin");
    events.push({ type: "shieldPrevented", target: instanceId });
    return { state: next, dealt: 0, events };
  }

  const plating = findCounter(state, instanceId, "plating");
  if (plating && plating.count > 0) {
    const dealt = Math.max(0, amount - plating.count);
    let next = adjustCounter(state, instanceId, "plating", -1, "beneficial", "builtin");
    events.push({ type: "platingReduced", target: instanceId, rawAmount: amount, reducedAmount: dealt });
    if (dealt > 0) {
      next = dealDamageTo(next, instanceId, dealt);
      events.push({ type: "damage", target: instanceId, amount: dealt });
    }
    return { state: next, dealt, events };
  }

  const next = dealDamageTo(state, instanceId, amount);
  events.push({ type: "damage", target: instanceId, amount });
  return { state: next, dealt: amount, events };
}

/**
 * Shield also prevents "the next damage-OR-destroy instance" per spec — so a
 * destroy effect checks for shield too, consuming it and negating the destroy
 * instead of moving the unit to the graveyard. Plating is damage-reduction only
 * and has no bearing on destroy. Returns prevented: false (with the original
 * state) when there's no shield to consume, so the caller proceeds normally.
 */
function tryShieldPreventDestroy(
  state: MatchState,
  instanceId: string
): { state: MatchState; prevented: boolean; events: ResolutionEvent[] } {
  const shield = findCounter(state, instanceId, "shield");
  if (shield && shield.count > 0) {
    const next = adjustCounter(state, instanceId, "shield", -1, "beneficial", "builtin");
    return { state: next, prevented: true, events: [{ type: "shieldPrevented", target: instanceId }] };
  }
  return { state, prevented: false, events: [] };
}

function healUnit(state: MatchState, instanceId: string, amount: number): MatchState {
  return updateUnit(state, instanceId, (u) => ({ ...u, damage: Math.max(0, u.damage - amount) }));
}

function freezeUnit(state: MatchState, instanceId: string, duration: import("../types/cards.js").Duration): MatchState {
  return updateUnit(state, instanceId, (u) => ({
    ...u,
    statusEffects: [...u.statusEffects, { kind: "frozen", expiresAt: duration }],
  }));
}

function buffUnit(
  state: MatchState,
  instanceId: string,
  power: number | undefined,
  toughness: number | undefined,
  duration: import("../types/cards.js").Duration
): MatchState {
  return updateUnit(state, instanceId, (u) => ({
    ...u,
    statusEffects: [...u.statusEffects, { kind: "statModifier", power, toughness, expiresAt: duration }],
  }));
}

/** Shared by addCounter/removeCounter: resolves a counter name's semantics/polarity.
 *  Only built-ins are supported right now — bespoke/generic counters are being
 *  reworked and explicitly not implemented yet (spec §9), so there's no polarity
 *  source for them to draw on; attempting to add one is a clear no-op with an event
 *  explaining why, rather than guessing a polarity. */
function withCounterMeta(
  counterName: string,
  apply: (semantics: "builtin" | "generic", polarity: "beneficial" | "detrimental") => void,
  onUnsupported: () => void
) {
  const semantics = counterSemantics(counterName);
  if (semantics === "generic") {
    onUnsupported();
    return;
  }
  apply(semantics, builtinCounterPolarity(counterName as BuiltinCounterName));
}

export function executeAction(
  state: MatchState,
  action: Action,
  ctx: EffectContext,
  targets: ObjectRef[]
): { state: MatchState; events: ResolutionEvent[] } {
  const events: ResolutionEvent[] = [];
  let next = state;

  switch (action.kind) {
    case "dealDamage":
      for (const t of targets) {
        const result = applyMitigatedDamage(next, t.objectId, action.amount);
        next = result.state;
        events.push(...result.events);
      }
      return { state: next, events };

    case "heal":
      for (const t of targets) {
        next = healUnit(next, t.objectId, action.amount);
        events.push({ type: "healed", target: t.objectId, amount: action.amount });
      }
      return { state: next, events };

    case "freeze":
      for (const t of targets) {
        next = freezeUnit(next, t.objectId, action.duration);
        events.push({ type: "frozen", target: t.objectId, duration: action.duration });
      }
      return { state: next, events };

    case "buffStat":
      for (const t of targets) {
        next = buffUnit(next, t.objectId, action.power, action.toughness, action.duration);
        events.push({ type: "buffed", target: t.objectId, power: action.power, toughness: action.toughness });
      }
      return { state: next, events };

    case "addCounter":
      for (const t of targets) {
        withCounterMeta(
          action.counterName,
          (semantics, polarity) => {
            next = adjustCounter(next, t.objectId, action.counterName, action.amount, polarity, semantics);
            events.push({
              type: "counterAdded",
              target: t.objectId,
              counterName: action.counterName,
              amount: action.amount,
            });
          },
          () =>
            events.push({
              type: "counterUnsupported",
              counterName: action.counterName,
              reason: "generic counters not yet implemented",
            })
        );
      }
      return { state: next, events };

    case "removeCounter":
      for (const t of targets) {
        withCounterMeta(
          action.counterName,
          (semantics, polarity) => {
            next = adjustCounter(next, t.objectId, action.counterName, -action.amount, polarity, semantics);
            events.push({
              type: "counterRemoved",
              target: t.objectId,
              counterName: action.counterName,
              amount: action.amount,
            });
          },
          () =>
            events.push({
              type: "counterUnsupported",
              counterName: action.counterName,
              reason: "generic counters not yet implemented",
            })
        );
      }
      return { state: next, events };

    case "destroy":
      for (const t of targets) {
        const shieldCheck = tryShieldPreventDestroy(next, t.objectId);
        next = shieldCheck.state;
        events.push(...shieldCheck.events);
        if (shieldCheck.prevented) continue;
        next = moveFromBattlefieldToGraveyard(next, t.objectId);
        events.push({ type: "destroyed", target: t.objectId });
      }
      return { state: next, events };

    case "sacrifice":
      for (const t of targets) {
        next = moveFromBattlefieldToGraveyard(next, t.objectId);
        events.push({ type: "sacrificed", target: t.objectId });
      }
      return { state: next, events };

    case "draw": {
      const player = next.players[ctx.controllerId];
      if (!player) return { state: next, events };
      const count = Math.min(action.count, player.zones.deck.length);
      const drawn = player.zones.deck.slice(0, count);
      next = {
        ...next,
        players: {
          ...next.players,
          [ctx.controllerId]: {
            ...player,
            zones: { ...player.zones, deck: player.zones.deck.slice(count), hand: [...player.zones.hand, ...drawn] },
          },
        },
      };
      events.push({ type: "drew", playerId: ctx.controllerId, instanceIds: drawn });
      return { state: next, events };
    }

    case "exile":
    case "discard":
    case "returnToHand":
    case "search":
    case "moveUnit":
    case "moveZone":
    case "negate":
    case "modifyCost":
    case "gainEnergy":
    case "gainInfluence":
    case "spendInfluence":
    case "copy":
    case "fuse":
    case "switchForm":
    case "createToken":
    case "transform":
    case "changeCardType":
    case "massIncrement":
    case "chooseOne":
    case "chooseAnyNumber":
    case "lookAtTopN":
    case "hook":
      // Not implemented yet — same pattern as everything else deferred in this
      // codebase: explicit and visible rather than a silent no-op. Listed
      // individually (rather than a bare `default`) so ESLint's
      // switch-exhaustiveness-check forces this list to shrink — and forces a
      // new Action kind to be added *somewhere* in this switch — the moment
      // either happens, instead of a new or still-unbuilt primitive silently
      // living inside an all-catching default forever.
      events.push({ type: "actionNotImplemented", kind: action.kind });
      return { state: next, events };

    default: {
      // Unreachable: the list above plus the explicit cases account for every
      // Action kind, enforced by switch-exhaustiveness-check at lint time. This
      // only exists as a runtime safety net in case a case is ever deleted
      // without ESLint being run.
      const exhaustive: never = action;
      events.push({ type: "actionNotImplemented", kind: (exhaustive as Action).kind });
      return { state: next, events };
    }
  }
}
