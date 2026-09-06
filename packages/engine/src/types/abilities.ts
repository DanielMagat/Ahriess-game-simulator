// Ability, trigger, target, and action types — see GAME_ENGINE_SPEC.md §4, §7

import type { CardType } from "./cards.js";

/**
 * Applies to ANY ability, not just Activated ones — moved off `Activated` itself
 * (which used to carry its own nested copy) after a real example surfaced a plain
 * triggered ability ("When X is met, draw a card. Once per game.") needing the
 * same limiting with no activation cost involved at all. One general mechanism,
 * not "usage limits, but only for the one trigger kind that happened to need it
 * first." See Ability.usageLimit below.
 */
export type UsageLimit = "none" | "oncePerTurn" | "oncePerGame" | { compound: UsageLimit[] };

export type TriggerSpec =
  | { kind: "EtB" }
  | { kind: "Fall" }
  | { kind: "SoT"; onlyOnTurn?: number }
  | { kind: "EoT" }
  | { kind: "PriorityWindow" } // "you may" effects usable during a priority window
  | { kind: "StartOfCombat" }
  | { kind: "DuringRepositioning" }
  | { kind: "DuringTrapPlacement" }
  | { kind: "EndOfTrapPlacement" } // before the trap stack resolves — distinct from the stack resolving
  | { kind: "TrapResolves" }
  | { kind: "StartOfDamage" }
  | { kind: "DealsCombatDamage" }
  | { kind: "TakesCombatDamage" }
  | { kind: "EndOfCombat" }
  | { kind: "LaneDeactivated" }
  | { kind: "Activated"; energyCost: number }
  | { kind: "Custom"; hook: string };

export type Allegiance = "allied" | "enemy" | "either";

export type LaneScope = "thisLane" | "adjacentLanes" | "otherLanes" | "allLanes";

export type SequencePosition = "first" | "last" | "all" | "any";

/** Targeting-scope only — "what KIND of zone to look for candidates in," relative
 *  to context (allegiance, etc.). For a concrete, fully-addressed move endpoint
 *  (which player's zone, which lane if battlefield) see ZoneLocation instead —
 *  the two are deliberately not the same type; see ZoneLocation's doc comment. */
export type ZoneRef = "hand" | "graveyard" | "deckTopN" | "battlefield";

export interface TargetSpec {
  allegiance?: Allegiance;
  laneScope?: LaneScope;
  position?: SequencePosition;
  zone?: ZoneRef;
  /** For deckTopN. */
  n?: number;
  /** Player chooses among candidates, vs. all candidates automatically selected. */
  playerChooses?: boolean;
  /** Player may choose any number of candidates (0..k), rather than exactly one. */
  anyNumber?: boolean;
}

/**
 * A concrete, fully-addressed zone endpoint for moveZone — as opposed to ZoneRef,
 * which is a targeting *scope* ("look in hand-type zones") not tied to a specific
 * player or lane. moveZone needs to know exactly whose hand, or exactly which
 * lane's battlefield, to actually move a card there; ZoneRef alone can't express
 * that. `mode` on the battlefield variant is optional because it's only needed
 * when committing a card to a mode for the first time (or overriding a prior
 * one) — see moveZone's doc comment in actions.ts for the full rule.
 */
export type ZoneLocation =
  | { kind: "deck" | "hand" | "graveyard" | "exile"; playerId: string }
  | { kind: "battlefield"; playerId: string; laneId: string; mode?: "A" | "B" };

/**
 * type/cost are ANDed together when both given (e.g. "a unit that costs 5" =
 * `{ type: "Unit", cost: { op: "eq", value: 5 } }`). Deliberately a flat optional-
 * field object rather than a generic predicate tree: today's confirmed criteria
 * are exactly these two, combinable; if more stats need to become searchable
 * later (power, toughness, keyword...), this shape extends the same way — one
 * more optional field, still ANDed — without needing a redesign now.
 */
export interface SearchCriteria {
  type?: CardType;
  cost?: { op: "eq" | "gt" | "lt"; value: number };
}

export type Action =
  // damage/healing
  | { kind: "dealDamage"; amount: number; target: TargetSpec }
  | { kind: "heal"; amount: number; target: TargetSpec }
  // card/zone movement
  | { kind: "draw"; count: number }
  | { kind: "discard"; count: number; target?: TargetSpec }
  | { kind: "exile"; target: TargetSpec }
  | { kind: "sacrifice"; target: TargetSpec }
  | { kind: "destroy"; target: TargetSpec }
  | { kind: "returnToHand"; target: TargetSpec }
  /**
   * Searches `zone` (the ability controller's own, by default — see actions.ts)
   * for cards matching `criteria`, checking BOTH of a card's modes independently.
   * `destination: "hand"` moves the whole physical card, uncommitted — either
   * mode can still be played later, since hand doesn't fix a mode (see spec §4).
   * `destination: "battlefield"` MUST commit to one of the specific mode(s) that
   * actually matched — a card whose mode A costs 1 but mode B costs 6 searched
   * for "costs 1" enters as mode A only, never mode B, even though it's the same
   * physical card. `laneId` defaults to the resolving ability's own lane when
   * omitted (the common case — "summon it here"); set it explicitly only for an
   * effect that puts the unit somewhere else.
   */
  | {
      kind: "search";
      zone: "deck" | "hand" | "graveyard" | "exile";
      criteria: SearchCriteria;
      destination: { kind: "hand" } | { kind: "battlefield"; laneId?: string };
    }
  /** `toLaneId` is a concrete destination, not a scope — by the time this action
   *  executes, "which lane" has already been decided, whether that's a player
   *  clicking "move left" during Repositioning (see turnMachine.ts's dedicated
   *  reposition handling, which computes legal destinations via lane adjacency
   *  and doesn't go through this generic Action path at all) or a card effect
   *  that already resolved its own destination some other way. */
  | { kind: "moveUnit"; target: TargetSpec; toLaneId: string }
  | { kind: "moveZone"; target: TargetSpec; from: ZoneLocation; to: ZoneLocation }
  // counters/stats
  | { kind: "addCounter"; counterName: string; amount: number; target: TargetSpec }
  | { kind: "removeCounter"; counterName: string; amount: number; target: TargetSpec }
  | {
      kind: "buffStat";
      power?: number;
      toughness?: number;
      target: TargetSpec;
      duration: import("./cards.js").Duration;
    }
  // board control
  | { kind: "freeze"; target: TargetSpec; duration: import("./cards.js").Duration }
  /**
   * `thisAbilityOnly` needs `abilityId` (see Ability.id) to know WHICH of the
   * target's abilities to silence — a card can have several, and negating one
   * must not affect the others. `allAbilitiesOfObject` silences everything on the
   * target regardless of id. `allCardsMatchingName` is structurally different
   * from the other two: it has to apply to any object with a matching name for
   * its duration, including ones that don't exist yet when it resolves, so it
   * can't live as a per-object StatusEffect the way the other two do — see
   * MatchState.activeNameNegations instead; `target` here is unused for that
   * variant (kept in the union for a uniform Action shape, but the resolver
   * should read `cardName` — TODO once card data exists to derive a name from).
   */
  | {
      kind: "negate";
      scope: "thisAbilityOnly" | "allAbilitiesOfObject" | "allCardsMatchingName";
      target: TargetSpec;
      duration: import("./cards.js").Duration;
    }
  // cost/economy
  | { kind: "modifyCost"; amount: number; scope: unknown; condition?: unknown }
  | { kind: "gainEnergy"; amount: number; temporary: boolean }
  | { kind: "gainInfluence"; color: "E" | "S" | "I" | "B" | "choice"; amount: number }
  | { kind: "spendInfluence"; color: "E" | "S" | "I" | "B"; amount: number }
  // meta-structural
  | { kind: "copy"; target: TargetSpec }
  | { kind: "fuse"; withTarget: TargetSpec }
  | { kind: "switchForm" }
  | { kind: "createToken"; tokenDefId: string; count: number; laneScope: LaneScope }
  | { kind: "transform" }
  /**
   * General in both directions, not a one-way "become a Unit" special case: the
   * resulting type set is (this object's current types, minus everything in
   * `from`) union `to`. That single rule covers pure replacement (from: [Structure],
   * to: [Unit] — a Structure becoming a Unit), pure addition (from: [], to: [Unit] —
   * gaining Unit-ness while keeping whatever it already had), and the reverse
   * (Unit -> Structure), without the engine needing separate code paths per
   * direction. `from`/`to` are each singular-or-plural (arrays) to match. When the
   * resulting type set newly includes Unit where it didn't before, the object is
   * added to the end of its lane's attack sequence, same as any other new Unit;
   * losing Unit-ness the same way is expected to reverse that (move it from
   * attackSequence to structures), though no card observed does this yet.
   */
  | { kind: "changeCardType"; target: TargetSpec; from: CardType[]; to: CardType[] }
  /** Increments counters by polarity relative to the effect's controller, not a
   *  fixed counter list: beneficial counters (+1/+1, plating, ...) on an ally,
   *  detrimental ones (-1/-1, poison, ...) on an enemy. Works against any TargetSpec
   *  scope — a single unit, "all enemy cards here", or "all cards everywhere" — since
   *  the ally/enemy check is per-object (compare the target's controller against
   *  this ability's controller) rather than baked into the targeting step itself. */
  | { kind: "massIncrement"; target: TargetSpec }
  // modal/choice — resolution-time decision points, not upfront targeting
  | { kind: "chooseOne"; options: Action[] }
  | { kind: "chooseAnyNumber"; options: Action[] }
  | { kind: "lookAtTopN"; n: number }
  // escape hatch for anything that doesn't decompose cleanly
  | { kind: "hook"; name: string };

export interface Ability {
  /** Optional, but required for two things: usage-limit tracking (below) and
   *  being the specific target of `Negate(scope: thisAbilityOnly)` — both need to
   *  refer to ONE ability among possibly several on the same mode unambiguously.
   *  Abilities that need neither can omit it. Author-assigned and stable (e.g.
   *  "drawOnCondition"), not positional, so it survives the ability list being
   *  reordered or added to later. */
  id?: string;
  trigger: TriggerSpec;
  condition?: unknown; // ConditionExpr — defined alongside the resolution engine
  target?: TargetSpec;
  action: Action[] | { hook: string };
  /** See UsageLimit's doc comment for why this lives here and not nested inside
   *  the Activated trigger — applies equally to a plain triggered ability like
   *  "When X is met, draw a card. Once per game." Tracked per-instance in
   *  CardInstance.abilityUsage, keyed by `id` above; an ability with a usageLimit
   *  but no `id` can't actually be tracked, so give one whenever you set this. */
  usageLimit?: UsageLimit;
}

/**
 * A specific in-game object reference, as opposed to a TargetSpec (a *description*
 * of what to select). Queued abilities lock in ObjectRefs at queue time — see §7.
 */
export interface ObjectRef {
  objectId: string;
}

/**
 * Anything sitting in the trap stack or the simultaneous-trigger queue.
 *
 * Only PLAYER-CHOSEN targets are snapshotted at queue time (`locked`) — the choice
 * itself is made then, per spec §7, and resolution only re-validates the chosen
 * objects still qualify, never re-selects. An automatic scope ("each enemy unit
 * here", no player agency in which ones) is the opposite: nothing is decided or
 * locked at queue time at all — `liveScope` just carries the original TargetSpec,
 * and resolution re-runs that query fresh against whatever the board looks like
 * *then*, picking up new qualifying objects and naturally excluding gone ones,
 * because it's a live query rather than a filtered snapshot. See GAME_ENGINE_SPEC.md §7.
 */
export type QueuedTargeting =
  | { kind: "none" }
  | { kind: "locked"; targets: ObjectRef[]; originalSelectionCriteria: TargetSpec }
  | { kind: "liveScope"; spec: TargetSpec };

export interface QueuedAbility {
  sourceAbilityId: string;
  controllerId: string;
  targeting: QueuedTargeting;
  action: Action[] | { hook: string };
}
