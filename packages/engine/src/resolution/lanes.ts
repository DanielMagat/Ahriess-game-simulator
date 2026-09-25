// Lane topology — deliberately its own small module (not folded into targeting.ts
// or turnMachine.ts) because BOTH need the exact same adjacency rule and neither
// should import from the other. See GAME_ENGINE_SPEC.md §3, Board layout.

import type { LaneState } from "../types/state.js";

/** A lane is deactivated when EITHER player's base in it has hit 0 — spec §3. No
 *  stored boolean; derived, same reasoning as computeCurrentStats/computeCurrentTypes
 *  in actions.ts: one source of truth (baseHealth), not a flag that could drift
 *  out of sync with it. */
export function isLaneDeactivated(lane: LaneState): boolean {
  return Object.values(lane.baseHealth).some((hp) => hp <= 0);
}

/**
 * The lanes adjacent to `fromLaneId` RIGHT NOW, accounting for deactivation —
 * not just the static wraparound ring. Confirmed rule (game designer, 2026-09):
 * lanes form a ring in their fixed board order (§3's wraparound: lane 1 and the
 * last lane are adjacent, same as any other neighboring pair) and a deactivated
 * lane is "basically removed from adjacency" — its two neighbors become adjacent
 * to EACH OTHER instead, exactly as if that lane's node were deleted from the
 * ring graph and the gap closed up. A unit sitting IN a deactivated lane still
 * uses its own position to ask "what's adjacent to here" (it can still be moved
 * OUT during repositioning), so `fromLaneId` itself doesn't need to be active —
 * only the lanes returned as neighbors do.
 *
 * Implementation: walk the ring one step at a time in each direction from
 * `fromLaneId`, skipping deactivated lanes, until landing on an active one (or
 * exhausting every other lane, meaning nothing's left to move to). This one
 * rule reproduces every case confirmed so far without special-casing "how many
 * lanes are deactivated": one gap just skips over one lane; two adjacent gaps
 * (e.g. lanes 2 and 3 both down) mean walking from lane 2 rightward skips past
 * 3 and lands on 4, so a unit in either deactivated lane ends up able to reach
 * both surviving lanes — which is exactly the confirmed "once two lanes are
 * deactivated, either deactivated lane's units can reach either remaining lane"
 * behavior, without that case needing its own code path.
 */
export function getEffectiveAdjacentLanes(lanes: LaneState[], fromLaneId: string): string[] {
  const ids = lanes.map((l) => l.id);
  const startIdx = ids.indexOf(fromLaneId);
  if (startIdx === -1) return [];
  const n = ids.length;

  const walk = (step: 1 | -1): string | undefined => {
    let i = (startIdx + step + n) % n;
    // At most n-1 other lanes exist to check; this bound alone guarantees we
    // never loop back around to startIdx, but the explicit check below is kept
    // as a cheap defensive backstop in case that invariant ever changes.
    for (let steps = 0; steps < n - 1; steps++) {
      if (i === startIdx) return undefined;
      if (!isLaneDeactivated(lanes[i])) return ids[i];
      i = (i + step + n) % n;
    }
    return undefined;
  };

  const left = walk(-1);
  const right = walk(1);
  return Array.from(new Set([left, right].filter((x): x is string => x !== undefined)));
}
