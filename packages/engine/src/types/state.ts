// Match state shape — see GAME_ENGINE_SPEC.md §5

import type { Counter, FusedDefinition } from "./cards.js";
import type { QueuedAbility } from "./abilities.js";

/**
 * "MainPhase" (not "TurnPriority" — renamed for clarity) is specifically the phase
 * where players alternate playing non-trap cards; the alternating-priority
 * *mechanism* it uses is shared with Repositioning and Trap Placement too, so naming
 * the phase after the mechanism was confusing. StartPhase and EndPhase are real
 * phases, not background processing that happens "between" turns: each involves a
 * player decision (which influence color to gain; what to discard down to 2) that
 * needs its own place in the state machine, potentially alongside SoT/EoT triggered
 * abilities needing target selection once the ability engine exists.
 */
export type Phase =
  "StartPhase" | "MainPhase" | "Repositioning" | "TrapPlacement" | "TrapResolution" | "Damage" | "EndPhase";

export interface InfluencePool {
  E: number;
  S: number;
  I: number;
  B: number;
}

export interface PlayerState {
  id: string;
  energy: { current: number; max: number };
  influence: InfluencePool;
  zones: {
    /** CardInstance ids — NOT CardDefinition ids. Each physical copy is tracked
     *  individually (see CardInstance below) specifically so its per-mode counter
     *  history survives it moving between zones. */
    deck: string[];
    hand: string[];
    graveyard: string[];
  };
}

export type StatusEffect =
  | { kind: "frozen"; expiresAt: import("./cards.js").Duration }
  | { kind: "phasedOut" } // deferred — not implemented; may be reworked to exile+resummon instead
  | { kind: "temporaryKeyword"; keyword: import("./cards.js").Keyword; expiresAt: import("./cards.js").Duration }
  /** Backs the `buffStat` action for BOTH temporary and permanent durations — not
   *  just temporary. Permanent stat buffs can't always be expressed as +1/+1
   *  counters (which move power and toughness together by the same amount); buffStat
   *  allows independent, possibly asymmetric deltas (e.g. +2/+0), so it needed its
   *  own representation rather than being sugar over the counter system. */
  | { kind: "statModifier"; power?: number; toughness?: number; expiresAt: import("./cards.js").Duration };

export type InstanceOrigin =
  | { kind: "card"; cardDefId: string }
  | { kind: "token"; tokenDefId: string }
  | { kind: "fusion"; fused: FusedDefinition };

/**
 * The persistent identity of one physical card/token/fusion, tracked across EVERY
 * zone (deck, hand, graveyard, battlefield) — not just while on the battlefield.
 * This is what makes the zone-change rule possible: "when a card moves to another
 * zone, effects on it (mostly counters) are kept, except damage" — damage is battlefield-
 * only (see BattlefieldUnit), but counters live here, independent of zone.
 *
 * Counters are tracked PER MODE for real two-mode cards: `countersByMode.A` and
 * `.B` are independent pools, so a card that accrued counters as mode A and later
 * gets resummoned as mode B starts mode B's pool fresh — resummoning as mode A again
 * later would still find its old mode-A counters intact. Tokens and fused objects
 * only ever occupy the one mode given by their fixed tag (see origin/activeMode
 * below), so only that side of the pool is ever populated for them; the other side
 * is simply never touched. A uniform two-key shape was chosen over a conditional
 * shape (one pool for cards, a different shape for tokens/fusions) to keep every
 * consumer's access pattern identical: `instance.countersByMode[instance.activeMode]`,
 * regardless of origin.
 */
export interface CardInstance {
  instanceId: string;
  origin: InstanceOrigin;
  countersByMode: { A: Counter[]; B: Counter[] };
  /** Which mode this instance currently "is". Freely switchable for `card`-origin
   *  instances (whichever mode it was most recently played/summoned as); fixed for
   *  `token`/`fusion` origins to match their definition's tag — a fused object
   *  "loses access to any modes on the components," so this becomes permanent once set. */
  activeMode: "A" | "B";
}

/**
 * The battlefield-only overlay for a CardInstance. Deliberately thin: identity,
 * counters, and mode all live on CardInstance (see above) because they survive zone
 * changes; only things that are genuinely battlefield-specific live here.
 *
 * Notably absent: currentPower/currentToughness. These are derived (base stats from
 * the instance's definition, plus its active counters, plus any statusEffects-driven
 * modifiers) rather than stored, to avoid a second source of truth that could drift
 * out of sync — computing them is a selector function, to be added alongside the
 * ability-resolution engine, not a stored field here.
 */
export interface BattlefieldUnit {
  instanceId: string;
  controllerId: string;
  laneId: string;
  /** NOT part of CardInstance — unlike counters, damage does not survive a zone
   *  change. Reset to 0 whenever an instance (re)enters the battlefield. */
  damage: number;
  statusEffects: StatusEffect[];
}

/**
 * Positional membership only — NOT a duplicate of CardInstance. `cardInstances`
 * (on MatchState, below) holds what an instance IS: its definition reference and
 * counters, independent of where it currently is. These lists hold WHERE it
 * currently is and, since order matters here (attack sequence position drives
 * combat resolution — see the combat module), WHAT ORDER. A given instanceId's
 * counters/identity are looked up once, in cardInstances; its position is looked
 * up by which list(s) currently contain it. A multi-typed object (see
 * ModeDefinition's `types`) that's simultaneously Structure and Unit is expected to
 * appear in BOTH lists at once — e.g. so "structures in this lane" effects can find
 * it while it also fights in combat.
 */
export interface LaneState {
  id: string;
  locationId: string;
  /** Keyed by playerId. */
  baseHealth: Record<string, number>;
  /** Keyed by playerId; ordered attack sequence, append-only at the end. Entries are
   *  instanceIds (a BattlefieldUnit's key IS its instanceId — an instance can only
   *  be on the battlefield once at a time, so no separate id is needed). */
  attackSequence: Record<string, string[]>;
  structures: Record<string, string[]>;
}

export type EventLogEntry = { type: string; [key: string]: unknown };

export interface MatchState {
  turnNumber: number;
  activePlayerId: string;
  attackTokenHolderId: string;
  attackTokenSpentThisTurn: boolean;
  phase: Phase;
  priorityPlayerId: string;
  consecutivePasses: number;
  /** Seed for a deterministic PRNG (shuffles, random targeting, etc. — none of
   *  which exist in code yet, hence this being currently unused/inert). Reserved
   *  now because retrofitting determinism after code has shipped using ad-hoc
   *  Math.random() calls is a much bigger, more error-prone change than reserving
   *  the field from the start — needed for replay/spectating, and for a future
   *  server-authoritative match to verify a client's random outcomes match. */
  rngSeed: number;
  eventLog: EventLogEntry[];
  players: Record<string, PlayerState>;
  lanes: LaneState[];
  triggerQueue: QueuedAbility[];
  /** Single stack across ALL lanes — traps are always set to a specific lane, but
   *  resolve in one shared LIFO order, not independently per lane. `instanceId`
   *  is the physical trap card itself (needed so it can be moved to the graveyard,
   *  etc. once resolved, and so its identity/counters stay reachable via
   *  cardInstances); `trap` is the QueuedAbility-shaped snapshot of what it does —
   *  see §7's target-snapshot rule for why that can't just be re-derived from the
   *  instance at resolution time. */
  globalTrapStack: { laneId: string; instanceId: string; trap: QueuedAbility }[];
  /** Every CardInstance in the match, regardless of zone — decks/hands/graveyards
   *  hold instanceIds that resolve against this registry, and units on the
   *  battlefield reference back into it too rather than duplicating its data. */
  cardInstances: Record<string, CardInstance>;
  /** Keyed by instanceId. */
  units: Record<string, BattlefieldUnit>;
}
