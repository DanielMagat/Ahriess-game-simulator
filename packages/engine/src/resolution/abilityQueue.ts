// Ability queueing/resolution — see GAME_ENGINE_SPEC.md §7.
//
// Anything that enters a queue (the trap stack, the simultaneous-trigger queue)
// snapshots its target selection at the moment it's queued, not at the moment it
// resolves — because arbitrary board changes can happen in between (an earlier
// queued ability killing a target; a new object appearing that shouldn't
// retroactively qualify). queueAbility does the snapshotting; resolveQueuedAbility
// does the re-validation-then-execute. Immediate (Main Phase) resolution doesn't
// need any of this — nothing can interleave between an ability being announced and
// it resolving there, so there's nothing to snapshot against; see spec §7.

import type { MatchState } from "../types/state.js";
import type { Ability, QueuedAbility } from "../types/abilities.js";
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
    // No targeting at all — e.g. "draw a card." Nothing to lock in.
    return {
      status: "queued",
      queued: {
        sourceAbilityId: ctx.sourceInstanceId ?? "unknown",
        controllerId: ctx.controllerId,
        lockedTargets: [],
        originalSelectionCriteria: {},
        action: ability.action,
      },
    };
  }

  const resolution = resolveTargetSpec(state, ability.target, ctx);
  if (resolution.needsPlayerChoice) {
    return {
      status: "needsDecision",
      reason: "target selection requires a player choice — decision-checkpoint mechanism not yet implemented (spec §9)",
    };
  }

  return {
    status: "queued",
    queued: {
      sourceAbilityId: ctx.sourceInstanceId ?? "unknown",
      controllerId: ctx.controllerId,
      lockedTargets: resolution.candidates,
      originalSelectionCriteria: ability.target,
      action: ability.action,
    },
  };
}

/**
 * Re-validates each locked target against the ORIGINAL selection criteria (see
 * targeting.ts's isStillValidTarget for exactly what "still valid" means, and why
 * position isn't part of that check), drops anything that no longer qualifies, then
 * executes the action against whatever survives — including the case where nothing
 * does, which is a valid outcome (the ability just does nothing), not an error.
 */
export function resolveQueuedAbility(
  state: MatchState,
  queued: QueuedAbility,
  ctx: EffectContext,
  definitions: DefinitionLookup
): { state: MatchState; events: ResolutionEvent[] } {
  const events: ResolutionEvent[] = [];

  const survivors = queued.lockedTargets.filter((ref) =>
    isStillValidTarget(state, ref, queued.originalSelectionCriteria, ctx)
  );
  const dropped = queued.lockedTargets.filter((ref) => !survivors.includes(ref));
  for (const d of dropped) {
    events.push({ type: "targetNoLongerValid", target: d.objectId });
  }

  if ("hook" in queued.action) {
    events.push({ type: "hookNotExecuted", hook: queued.action.hook });
    return { state, events };
  }

  let next = state;
  for (const action of queued.action) {
    const result = executeAction(next, action, ctx, survivors);
    next = result.state;
    events.push(...result.events);
  }

  const deathSweep = processStateBasedDeaths(next, definitions);
  next = deathSweep.state;
  events.push(...deathSweep.events);

  return { state: next, events };
}
