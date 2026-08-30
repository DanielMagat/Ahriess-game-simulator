// Damage-phase combat resolution — see GAME_ENGINE_SPEC.md §8
//
// Three structures per side:
//   - roster: the persistent, order-preserving live unit list (mirrors the real attack
//     sequence). Append-only for new arrivals; units are never removed from it, liveness
//     is checked via toughness/removed instead. Source of truth for "who's still alive."
//   - active queue: transient FIFO of units still owed their own initiating turn this
//     combat. Seeded from the roster at combat start; new arrivals (death-triggered
//     summons, etc.) are pushed onto it too, so they get their own turn. Pairs off
//     against the opponent's active queue whenever both are non-empty. Drives whether
//     the lane's combat continues at all — an empty active queue on both sides ends it,
//     regardless of what's left in a passive queue.
//   - passive queue: transient FIFO, built lazily and only when needed — the moment one
//     side's active queue is empty but the other side still has an active unit needing
//     an opponent. Built from whichever of that side's roster units are currently alive,
//     consumed by popping (so multiple excess units distribute sequentially across
//     survivors instead of repeatedly finding the same one). Once drained, it's rebuilt
//     fresh from whoever's alive at that later moment the next time it's needed —
//     this is what allows multiple full laps when there's a big enough mismatch.

export interface CombatUnit {
  id: string;
  power: number;
  toughness: number; // current remaining toughness; <= 0 means dead
  frozen: boolean;
  hasFirstStrike: boolean;
  /** Set by external effects that remove a unit from the lane for reasons other than
   *  combat damage (bounce, exile, etc.) — see spec §8, "removed from the lane while
   *  still in the queue." */
  removed?: boolean;
  /**
   * Current shield/plating counter counts, if any. Deliberately two plain numbers
   * rather than importing the real `Counter[]` type from types/cards.ts — this
   * module stays self-contained (own types, own tests, no MatchState dependency)
   * by design, so a caller building CombatUnit from real state is responsible for
   * projecting a unit's actual counters down to these two numbers going in, and
   * for writing the depleted counts (see applyDamage below) back into the real
   * CardInstance afterward. That translation isn't wired up yet — see the
   * "known integration gap" in the README — but the mitigation rule itself is
   * correct and tested here independent of that wiring.
   *
   * Precedence (not specified in the original spec text — flagged for
   * confirmation, see handoff notes): shield is checked first. If present, it
   * fully absorbs the hit and depletes by 1; plating is untouched that hit.
   * Only if there's no shield does plating reduce the damage (floor 0) and then
   * deplete by 1 regardless of how much it absorbed.
   */
  shieldCount?: number;
  platingCount?: number;
}

export type CombatEvent =
  | { type: "mutualFight"; a: string; b: string }
  | { type: "noFight"; a: string; b: string; reason: "bothFrozen" }
  | { type: "damage"; source: string; target: string; amount: number }
  | { type: "shieldPrevented"; source: string; target: string }
  | { type: "platingReduced"; source: string; target: string; rawAmount: number; reducedAmount: number }
  | { type: "unitDied"; id: string }
  | { type: "droppedDeadFromQueue"; id: string; queue: "active" | "passive" }
  | { type: "passiveQueueBuilt"; side: "A" | "B"; memberIds: string[] }
  | { type: "excessNoOp"; source: string; reason: "frozen" }
  | { type: "excessBaseDamage"; source: string; side: "A" | "B"; amount: number }
  | { type: "laneDeactivated" };

export interface CombatRosters {
  rosterA: CombatUnit[];
  rosterB: CombatUnit[];
  activeA: CombatUnit[];
  activeB: CombatUnit[];
}

export interface LaneCombatHooks {
  dealDamageToBase(side: "A" | "B", amount: number, sourceUnitId: string): void;
  isLaneDeactivated(): boolean;
  /** Called after every discrete combat step (each pairing, each excess event), and
   *  once more mid-matchup between a first striker's hit and the retaliation. May
   *  mutate the rosters/active queues in place (e.g. push newly-summoned units —
   *  these should be pushed to BOTH the roster and that side's active queue, so they
   *  become eligible for future passive-queue rebuilds and get their own initiating
   *  turn this combat). */
  drainTriggersAndStatics(rosters: CombatRosters): void;
}

const isAlive = (u: CombatUnit): boolean => u.toughness > 0 && !u.removed;

/**
 * Whether this unit would currently deal damage if asked to act — i.e. it still
 * exists AND nothing is suppressing its ability to deal damage (frozen today;
 * anything with equivalent semantics added later plugs in here too). This is
 * evaluated fresh at each point damage would be dealt, not cached, which is what
 * makes "first striker's damage/effects resolve fully, THEN check whether the
 * target can still hit back" work for ANY effect that could intervene in between —
 * killing the target, freezing it, or (in the future) anything else that revokes
 * its ability to deal damage — without that effect needing to be first-strike-aware
 * itself. A card author writing "when this deals damage to a unit, freeze it" gets
 * the first-strike interaction for free; nothing about first strike needs to know
 * that specific effect exists.
 */
const canDealDamage = (u: CombatUnit): boolean => isAlive(u) && !u.frozen;

export function resolveLaneCombat(
  initialSideA: CombatUnit[],
  initialSideB: CombatUnit[],
  hooks: LaneCombatHooks
): CombatEvent[] {
  const events: CombatEvent[] = [];
  const emit = (e: CombatEvent) => events.push(e);

  const rosterA = [...initialSideA];
  const rosterB = [...initialSideB];
  const activeA = [...initialSideA];
  const activeB = [...initialSideB];
  const rosters: CombatRosters = { rosterA, rosterB, activeA, activeB };

  // Passive queues are lazily built — null/empty both mean "needs (re)building next time".
  let passiveA: CombatUnit[] = [];
  let passiveB: CombatUnit[] = [];

  const dropDeadFromFront = (queue: CombatUnit[], which: "active" | "passive") => {
    while (queue.length && !isAlive(queue[0])) {
      const gone = queue.shift()!;
      emit({ type: "droppedDeadFromQueue", id: gone.id, queue: which });
    }
  };

  const applyDamage = (source: CombatUnit, target: CombatUnit) => {
    const raw = source.power;
    let dealt = raw;

    if ((target.shieldCount ?? 0) > 0) {
      target.shieldCount = (target.shieldCount ?? 0) - 1;
      emit({ type: "shieldPrevented", source: source.id, target: target.id });
      dealt = 0;
    } else if ((target.platingCount ?? 0) > 0) {
      const before = target.platingCount ?? 0;
      dealt = Math.max(0, raw - before);
      target.platingCount = before - 1; // depletes by exactly 1 regardless of how much it blocked
      emit({ type: "platingReduced", source: source.id, target: target.id, rawAmount: raw, reducedAmount: dealt });
    }

    if (dealt > 0) {
      target.toughness -= dealt;
      emit({ type: "damage", source: source.id, target: target.id, amount: dealt });
    }
    if (!isAlive(target)) {
      emit({ type: "unitDied", id: target.id });
    }
  };

  const resolveMutual = (u: CombatUnit, v: CombatUnit) => {
    emit({ type: "mutualFight", a: u.id, b: v.id });
    if (u.frozen && v.frozen) {
      emit({ type: "noFight", a: u.id, b: v.id, reason: "bothFrozen" });
      return;
    }
    if (u.hasFirstStrike !== v.hasFirstStrike) {
      const striker = u.hasFirstStrike ? u : v;
      const other = u.hasFirstStrike ? v : u;
      if (canDealDamage(striker)) applyDamage(striker, other);
      hooks.drainTriggersAndStatics(rosters); // other may die, get frozen, etc. here before retaliating
      if (canDealDamage(other)) applyDamage(other, striker);
    } else {
      // Simultaneous: both hits land regardless of whether one is lethal to the other.
      if (canDealDamage(u)) applyDamage(u, v);
      if (canDealDamage(v)) applyDamage(v, u);
    }
  };

  /** Pops the next opponent for an excess unit from the given side's passive queue,
   *  rebuilding it from currently-alive roster members if it's currently empty.
   *  Returns undefined only if that side has no living units left in the lane at all. */
  const popFromPassive = (side: "A" | "B"): CombatUnit | undefined => {
    const passive = side === "A" ? passiveA : passiveB;
    const roster = side === "A" ? rosterA : rosterB;
    dropDeadFromFront(passive, "passive");
    if (passive.length === 0) {
      const living = roster.filter(isAlive);
      passive.push(...living);
      if (passive.length > 0) {
        emit({ type: "passiveQueueBuilt", side, memberIds: passive.map((u) => u.id) });
      }
    }
    return passive.shift();
  };

  const resolveExcess = (u: CombatUnit, opposingSide: "A" | "B") => {
    if (!canDealDamage(u)) {
      // Frozen is the only cause of this today, hence the literal reason string —
      // generalize CombatEvent's "reason" type too if a second cause is ever added.
      emit({ type: "excessNoOp", source: u.id, reason: "frozen" });
      return;
    }
    const opponent = popFromPassive(opposingSide);
    if (opponent) {
      resolveMutual(u, opponent); // opponent may already have had its own turn — that's fine
    } else {
      emit({ type: "excessBaseDamage", source: u.id, side: opposingSide, amount: u.power });
      hooks.dealDamageToBase(opposingSide, u.power, u.id);
    }
  };

  // The loop is driven ONLY by the active queues — a passive queue by itself never
  // keeps combat going, it's purely a lookup resource for whichever side still has
  // an active turn to take.
  while (activeA.length || activeB.length) {
    dropDeadFromFront(activeA, "active");
    dropDeadFromFront(activeB, "active");

    if (activeA.length && activeB.length) {
      const u = activeA.shift()!;
      const v = activeB.shift()!;
      resolveMutual(u, v);
    } else if (activeA.length) {
      const u = activeA.shift()!;
      resolveExcess(u, "B");
    } else {
      const v = activeB.shift()!;
      resolveExcess(v, "A");
    }

    hooks.drainTriggersAndStatics(rosters);
    if (hooks.isLaneDeactivated()) {
      emit({ type: "laneDeactivated" });
      break;
    }
  }

  return events;
}
