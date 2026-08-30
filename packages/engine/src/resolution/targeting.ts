// Target resolution — see GAME_ENGINE_SPEC.md §4 (TargetSpec) and §7 (why this is
// split into "compute candidates now" vs. "narrow via player choice" as different
// concerns, and why the caller — abilityQueue.ts — is the one that decides whether
// that split matters, not this module).

import type { MatchState } from "../types/state.js";
import type { Allegiance, LaneScope, SequencePosition, TargetSpec, ObjectRef } from "../types/abilities.js";

export interface EffectContext {
  /** Who controls/owns the effect being resolved — the reference point for "allied"/"enemy". */
  controllerId: string;
  /** The card/token whose ability this is, if any (abilities always have one; not
   *  every Action invocation necessarily does, e.g. a generic sweep effect). */
  sourceInstanceId?: string;
  /** "This lane" reference point. Absent for effects with no lane-relative source
   *  (e.g. a global sweep) — lane-scoped TargetSpecs are meaningless without it. */
  sourceLaneId?: string;
}

export interface TargetResolution {
  candidates: ObjectRef[];
  /** True if `candidates` is a pool that still needs narrowing by a player choice
   *  (one, or up to `anyNumber`) before it's a final target set — see TargetSpec's
   *  `playerChooses`. This module only computes the deterministic candidate pool;
   *  narrowing it via player choice is the decision-checkpoint mechanism (spec §7),
   *  deferred — see abilityQueue.ts for how callers are expected to handle `true` here. */
  needsPlayerChoice: boolean;
}

export function otherPlayerId(state: MatchState, playerId: string): string {
  const found = Object.keys(state.players).find((id) => id !== playerId);
  if (!found) throw new Error(`otherPlayerId: no second player found besides ${playerId}`);
  return found;
}

function laneIdsInScope(
  state: MatchState,
  laneScope: LaneScope | undefined,
  sourceLaneId: string | undefined
): string[] {
  const allLaneIds = state.lanes.map((l) => l.id);
  if (!sourceLaneId) return allLaneIds; // no lane-relative source -> nothing to be relative to
  const idx = allLaneIds.indexOf(sourceLaneId);
  if (idx === -1) return allLaneIds;
  switch (laneScope) {
    case "adjacentLanes": {
      // Wraparound: leftmost and rightmost lanes are adjacent — see spec §8's combat
      // note on the same convention (this is the same board, same adjacency rule).
      const n = allLaneIds.length;
      const left = allLaneIds[(idx - 1 + n) % n];
      const right = allLaneIds[(idx + 1) % n];
      return Array.from(new Set([left, right]));
    }
    case "otherLanes":
      return allLaneIds.filter((id) => id !== sourceLaneId);
    case "allLanes":
      return allLaneIds;
    case "thisLane":
    case undefined:
    default:
      // "this lane" dominates overwhelmingly in the card pool — the sensible default
      // for an omitted laneScope on a lane-relative source. `case undefined` is
      // listed explicitly (not just caught by default) because
      // switch-exhaustiveness-check treats "member of the type" and "default
      // fallthrough" as different things to verify.
      return [sourceLaneId];
  }
}

function matchesAllegiance(
  objControllerId: string,
  allegiance: Allegiance | undefined,
  effectControllerId: string
): boolean {
  if (!allegiance || allegiance === "either") return true;
  if (allegiance === "allied") return objControllerId === effectControllerId;
  return objControllerId !== effectControllerId; // "enemy"
}

/** "first"/"last" apply WITHIN each (lane, player) grouping independently — e.g.
 *  laneScope "allLanes" + position "first" means the first unit in each lane, for
 *  each matching player, not a single globally-first unit. "all"/"any"/undefined
 *  apply no position filtering at all — see targeting.test.ts for the reasoning on
 *  why "any" isn't treated as "engine picks one" here (that's a choice, deferred). */
function applyPositionFilter(orderedIds: string[], position: SequencePosition | undefined): string[] {
  if (position === "first") return orderedIds.length > 0 ? [orderedIds[0]] : [];
  if (position === "last") return orderedIds.length > 0 ? [orderedIds[orderedIds.length - 1]] : [];
  return orderedIds;
}

function dedupe(refs: ObjectRef[]): ObjectRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.objectId)) return false;
    seen.add(r.objectId);
    return true;
  });
}

/** Battlefield objects only (units + structures) — the default and by far the most
 *  common case (no card in the pool used explicit "target" language at all; scope
 *  is always lane/allegiance/position-based). A multi-typed object that's both
 *  Structure and Unit (spec §4) appears in both lists for its lane — deduped here
 *  so it isn't returned twice. */
function resolveBattlefieldCandidates(state: MatchState, spec: TargetSpec, ctx: EffectContext): ObjectRef[] {
  const laneIds = laneIdsInScope(state, spec.laneScope, ctx.sourceLaneId);
  const results: ObjectRef[] = [];
  for (const laneId of laneIds) {
    const lane = state.lanes.find((l) => l.id === laneId);
    if (!lane) continue;
    for (const [playerId, seq] of Object.entries(lane.attackSequence)) {
      if (!matchesAllegiance(playerId, spec.allegiance, ctx.controllerId)) continue;
      results.push(...applyPositionFilter(seq, spec.position).map((id) => ({ objectId: id })));
    }
    for (const [playerId, seq] of Object.entries(lane.structures)) {
      if (!matchesAllegiance(playerId, spec.allegiance, ctx.controllerId)) continue;
      results.push(...applyPositionFilter(seq, spec.position).map((id) => ({ objectId: id })));
    }
  }
  return dedupe(results);
}

/** Hand/graveyard/deck-top-N — whose zone is determined by `allegiance` the same
 *  way it determines whose units count as allied: "enemy" means the opposing
 *  player's zone, not (as in some engines) an illegal combination. */
function resolveZoneCandidates(state: MatchState, spec: TargetSpec, ctx: EffectContext): ObjectRef[] {
  const playerId = spec.allegiance === "enemy" ? otherPlayerId(state, ctx.controllerId) : ctx.controllerId;
  const player = state.players[playerId];
  if (!player) return [];
  if (spec.zone === "hand") return player.zones.hand.map((id) => ({ objectId: id }));
  if (spec.zone === "graveyard") return player.zones.graveyard.map((id) => ({ objectId: id }));
  if (spec.zone === "deckTopN") {
    // Convention: index 0 is the top of the deck.
    return player.zones.deck.slice(0, spec.n ?? 1).map((id) => ({ objectId: id }));
  }
  return [];
}

export function resolveTargetSpec(state: MatchState, spec: TargetSpec, ctx: EffectContext): TargetResolution {
  const isZoneScoped = spec.zone === "hand" || spec.zone === "graveyard" || spec.zone === "deckTopN";
  const candidates = isZoneScoped
    ? resolveZoneCandidates(state, spec, ctx)
    : resolveBattlefieldCandidates(state, spec, ctx);
  return { candidates, needsPlayerChoice: !!spec.playerChooses };
}

/**
 * Re-validates a single previously-locked target against the ORIGINAL selection
 * criteria, at whatever later moment it's actually needed (resolution time for a
 * queued ability — see abilityQueue.ts). This is deliberately NOT "run the query
 * again" — it only asks "does this specific object still qualify," never picks a
 * replacement. Position ("first"/"last") is intentionally not re-checked: it was a
 * selection-time query over the board, not an ongoing property of the object, so
 * whether something is STILL literally first after reordering is irrelevant —
 * what matters is whether the object we already locked in is still there and still
 * satisfies the durable criteria (allegiance, zone/lane membership). See spec §7.
 */
export function isStillValidTarget(
  state: MatchState,
  ref: ObjectRef,
  criteria: TargetSpec,
  ctx: EffectContext
): boolean {
  const isZoneScoped = criteria.zone === "hand" || criteria.zone === "graveyard" || criteria.zone === "deckTopN";
  if (isZoneScoped) {
    const playerId = criteria.allegiance === "enemy" ? otherPlayerId(state, ctx.controllerId) : ctx.controllerId;
    const player = state.players[playerId];
    if (!player) return false;
    const zoneList =
      criteria.zone === "hand"
        ? player.zones.hand
        : criteria.zone === "graveyard"
          ? player.zones.graveyard
          : player.zones.deck;
    return zoneList.includes(ref.objectId);
  }

  const unit = state.units[ref.objectId];
  if (!unit) return false; // no longer on the battlefield at all
  if (!matchesAllegiance(unit.controllerId, criteria.allegiance, ctx.controllerId)) return false;
  if (ctx.sourceLaneId) {
    const validLaneIds = laneIdsInScope(state, criteria.laneScope, ctx.sourceLaneId);
    if (!validLaneIds.includes(unit.laneId)) return false;
  }
  return true;
}
