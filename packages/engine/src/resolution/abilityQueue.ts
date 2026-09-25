// Ability queueing/resolution — see GAME_ENGINE_SPEC.md §7.
//
// Two very different things happen at queue time depending on the target's shape:
// - A player-CHOSEN target ("choose an enemy unit") is decided right now, at queue
//   time, and locked — resolution only re-validates that specific choice still
//   qualifies (existence, allegiance, lane membership), never re-selects to fill a
//   gap. This is what protects against board drift between queueing and resolving.
// - An automatic SCOPE ("each enemy unit here", no player agency in which ones) is
//   the opposite: nothing is decided or locked at queue time at all. Resolution
//   re-runs the same query live, against the board as it actually looks in that
//   moment — new qualifying objects that showed up in between ARE included, same
//   as gone ones naturally aren't, because it's a fresh query, not a filtered
//   snapshot.
// queueAbility picks which of these applies; resolveQueuedAbility acts on whichever
// it got. Immediate (Main Phase) resolution doesn't need any of this — nothing can
// interleave between an ability being announced and it resolving there, so there's
// nothing to snapshot against or defer; see spec §7.

import type { MatchState } from "../types/state.js";
import type { Ability, QueuedAbility, ObjectRef } from "../types/abilities.js";
import { EffectContext, resolveTargetSpec, isStillValidTarget } from "./targeting.js";
import { executeAction, processStateBasedDeaths, DefinitionLookup, ResolutionEvent } from "./actions.js";

export type QueueResult =
  | { status: "queued"; queued: QueuedAbility }
  /** Player-chosen targeting happens AT QUEUE TIME per §7 ("a player choice is made
   *  when the ability is queued, not when it comes up for resolution") — so this
   *  isn't deferred to resolution, it blocks queueing itself. The full decision-
   *  checkpoint mechanism (pause, request input, resume) is its own slice of work;
   *  this status exists so callers can detect the need clearly rather than the
   *  ability silently queueing with an incomplete/wrong target set. */
  | { status: "needsDecision"; reason: string };

export function queueAbility(state: MatchState, ability: Ability, ctx: EffectContext): QueueResult {
  if (!ability.target) {
    // No targeting at all — e.g. "draw a card." Nothing to lock in or defer.
    return {
      status: "queued",
      queued: {
        sourceAbilityId: ctx.sourceInstanceId ?? "unknown",
        controllerId: ctx.controllerId,
        targeting: { kind: "none" },
        action: ability.action,
      },
    };
  }

  if (ability.target.playerChooses) {
    // A player choice — must be made now, at queue time, not deferred to
    // resolution. The decision-checkpoint mechanism that would actually ask the
    // player and come back with their pick isn't built yet; once it is, a
    // successful response becomes `{ kind: "locked", targets: <their pick>,
    // originalSelectionCriteria: ability.target }`.
    return {
      status: "needsDecision",
      reason: "target selection requires a player choice — decision-checkpoint mechanism not yet implemented (spec §9)",
    };
  }

  // Automatic scope: nothing to decide, and per spec §7 nothing to lock in either —
  // just carry the spec forward so resolution can run it fresh, live, later.
  return {
    status: "queued",
    queued: {
      sourceAbilityId: ctx.sourceInstanceId ?? "unknown",
      controllerId: ctx.controllerId,
      targeting: { kind: "liveScope", spec: ability.target },
      action: ability.action,
    },
  };
}

/**
 * For a `locked` (player-chosen) targeting: re-validates each locked target against
 * the ORIGINAL selection criteria (see targeting.ts's isStillValidTarget for exactly
 * what "still valid" means, and why position isn't part of that check), drops
 * anything that no longer qualifies, and never re-selects to fill the gap.
 *
 * For a `liveScope` (automatic) targeting: re-runs the original TargetSpec query
 * fresh, right now — this is a live lookup, not a filter over a snapshot, so there's
 * nothing to "drop": whoever currently matches gets included, whether or not they
 * existed back when this ability was queued.
 *
 * Either way, the action then executes against whatever survives — including the
 * case where nothing does, which is a valid outcome (the ability just does
 * nothing), not an error.
 */
export function resolveQueuedAbility(
  state: MatchState,
  queued: QueuedAbility,
  ctx: EffectContext,
  definitions: DefinitionLookup
): { state: MatchState; events: ResolutionEvent[] } {
  const events: ResolutionEvent[] = [];

  let survivors: ObjectRef[];

  if (queued.targeting.kind === "none") {
    survivors = [];
  } else if (queued.targeting.kind === "locked") {
    const { targets, originalSelectionCriteria } = queued.targeting;
    const stillValid = targets.filter((ref) => isStillValidTarget(state, ref, originalSelectionCriteria, ctx));
    const dropped = targets.filter((ref) => !stillValid.includes(ref));
    for (const d of dropped) {
      events.push({ type: "targetNoLongerValid", target: d.objectId });
    }
    survivors = stillValid;
  } else {
    // liveScope
    survivors = resolveTargetSpec(state, queued.targeting.spec, ctx).candidates;
  }

  if ("hook" in queued.action) {
    events.push({ type: "hookNotExecuted", hook: queued.action.hook });
    return { state, events };
  }

  let next = state;
  for (const action of queued.action) {
    const result = executeAction(next, action, ctx, survivors, definitions);
    next = result.state;
    events.push(...result.events);
  }

  const deathSweep = processStateBasedDeaths(next, definitions);
  next = deathSweep.state;
  events.push(...deathSweep.events);

  return { state: next, events };
}
