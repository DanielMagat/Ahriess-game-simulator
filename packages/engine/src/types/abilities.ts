// Ability, trigger, target, and action types — see GAME_ENGINE_SPEC.md §4, §7

import type { CardType } from "./cards.js";

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
  | { kind: "Activated"; energyCost: number; usageLimit: UsageLimit }
  | { kind: "Custom"; hook: string };

export type Allegiance = "allied" | "enemy" | "either";

export type LaneScope = "thisLane" | "adjacentLanes" | "otherLanes" | "allLanes";

export type SequencePosition = "first" | "last" | "all" | "any";

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
  | { kind: "search"; query: unknown }
  | { kind: "moveUnit"; target: TargetSpec; toLane: LaneScope }
  | { kind: "moveZone"; target: TargetSpec; from: ZoneRef; to: ZoneRef }
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
  trigger: TriggerSpec;
  condition?: unknown; // ConditionExpr — defined alongside the resolution engine
  target?: TargetSpec;
  action: Action[] | { hook: string };
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
 * Selection is snapshotted at queue time; resolution re-validates against the
 * original criteria rather than re-running the selection query. See GAME_ENGINE_SPEC.md §7.
 */
export interface QueuedAbility {
  sourceAbilityId: string;
  controllerId: string;
  lockedTargets: ObjectRef[];
  originalSelectionCriteria: TargetSpec;
  action: Action[] | { hook: string };
}
