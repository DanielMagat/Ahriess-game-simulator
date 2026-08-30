// Card data model — see GAME_ENGINE_SPEC.md §4

export type CardType = "Unit" | "Structure" | "Invocation" | "Trap";

/**
 * A set of influence pips. Deliberately NOT named "...Cost" — the same shape means
 * two different things depending on which mode it's attached to:
 *   - On a non-Trap mode: a REQUIREMENT. You must currently own at least this many
 *     of each color; nothing is spent/consumed to play the card.
 *   - On a Trap mode: an actual COST. This amount is permanently consumed
 *     (subtracted) from your influence pools when the trap is set.
 * `isInfluenceConsumed()` below is the single place that decides which applies —
 * derive it from a mode's `type` there rather than re-deriving `=== "Trap"` at
 * every call site that pays/checks a cost.
 */
export interface InfluencePips {
  E: number;
  S: number;
  I: number;
  B: number;
  wildcard: number; // payable/satisfiable with any single color, per-pip
}

export interface ModeCost {
  /** Absent for Trap modes — traps have influence cost only, no energy cost. */
  energy?: number;
  influence: InfluencePips;
}

/** Whether `cost.influence` on a mode of this type is consumed (Trap) or merely
 *  required-but-not-spent (everything else). See InfluencePips above. */
export function isInfluenceConsumed(type: CardType): boolean {
  return type === "Trap";
}

export type Keyword =
  // "When this deals damage to a unit, put n poison counters on it." Poison counters
  // are a built-in counter type (see below) that deal 1 damage per stack at END OF
  // TURN — explicitly not end of combat, reworked from the original design.
  | { kind: "Poisonous"; n: number }
  | { kind: "Agile"; n: number }
  | { kind: "Immobile" }
  | { kind: "Wither" }
  | { kind: "FirstStrike" }
  | { kind: "Deathtouch" }
  | { kind: "Lifelink" }
  | { kind: "Ephemeral" } // sacrifice this permanent at end of turn; usable on any Unit/Structure mode
  | { kind: "MoraleBreaker"; n: number }; // "when this kills an enemy unit in combat, deal n damage to enemy base"

import type { Ability } from "./abilities.js";

/**
 * `types` (plural) because a mode's type set is NOT always a singleton — a handful
 * of effects transform a Structure on the board into a Unit (with power/toughness),
 * and it's possible for a non-fused card to be simultaneously Structure AND Unit.
 * (Originally this was a single `type`, reasoned from the card pool sampled so far
 * never showing a multi-typed non-fused card — that premise turned out to be wrong,
 * so the shape changed rather than keeping a narrower one "because the data
 * supported it so far.") `FusedDefinition` uses the same `types: CardType[]` shape,
 * so there's now exactly one representation for "what type(s) is this," not two.
 */
export interface ModeDefinition {
  name: string;
  types: CardType[];
  cost: ModeCost;
  /** Present only while Unit is among `types`. */
  basePower?: number;
  baseToughness?: number;
  keywords: Keyword[];
  abilities: Ability[];
}

export interface CardDefinition {
  id: string;
  setCode?: string;
  collectorInfo?: string;
  imageURL?: string;
  /** Always includes Unit | Structure | Invocation — never includes Trap. */
  modeA: ModeDefinition;
  /** May include Unit | Structure | Invocation | Trap, alone or (per the note above) combined. */
  modeB: ModeDefinition;
}

/**
 * Game-generated objects. Not deck cards in the usual sense, but — per the
 * "tokens can exist in zones other than the battlefield" rule — they CAN end up in
 * a player's hand (returned, bounced, etc.), so they need a real cost/influence
 * requirement to be playable from there, exactly like a card mode. `types` can
 * include Invocation or Trap too, not just Unit/Structure — e.g. an effect that
 * adds a token Invocation to a player's hand is valid design space here even
 * though it has no MTG equivalent.
 *
 * `modeTag` exists because some effects check "is this a first-mode object,"
 * regardless of whether the object is a real card or a token — a token usually
 * doesn't have an actual second mode to switch to, it just permanently carries
 * whichever tag it was designed with.
 *
 * Naming convention (content, not engine, concern): each TokenDefinition's name is
 * now unique to its specific stat/ability block — no more reusing e.g. "Beast" across
 * different power levels. Multiple different cards may still reference the SAME
 * TokenDefinition id, though.
 */
export interface TokenDefinition {
  id: string;
  name: string;
  types: CardType[];
  cost: ModeCost;
  modeTag: "A" | "B";
  basePower?: number;
  baseToughness?: number;
  abilities?: Ability[];
}

/** Assigned pre-game via the draft procedure; not part of either deck. See spec §3
 *  "Deckbuilding" for the current single-shared-pool, uniform-weighting rule, and the
 *  note on keeping the eventual draft-assignment code open to future weighting/pooling. */
export interface LocationDefinition {
  id: string;
  name: string;
  abilities: Ability[];
}

/**
 * The result of Fuse: components merge into ONE new object. Cost/power/toughness
 * are the sum of the components'; types, keywords, and abilities are the union.
 * A fused object loses access to any modes its components had — it's a single new
 * identity from here on, in every zone, not just the battlefield — but it still
 * carries a fixed mode-like tag (`isFirstMode`) for effects that check that, true
 * only when EVERY component was itself a first-mode object.
 *
 * `basePower`/`baseToughness` are nullable: an all-Structure fusion (no Unit among
 * any component) has neither, same as a non-Unit ModeDefinition. When at least one
 * component IS (partly) a Unit, sum treating any non-Unit component's missing
 * value as 0.
 */
export interface FusedDefinition {
  name: string;
  types: CardType[];
  cost: ModeCost;
  basePower?: number;
  baseToughness?: number;
  keywords: Keyword[];
  abilities: Ability[];
  isFirstMode: boolean;
  /** Lineage — which physical instances fused together. Not the same as an
   *  "unfuse" capability; fusion is one-directional per spec. */
  componentInstanceIds: string[];
}

export type CounterSemantics = "builtin" | "generic";
export type CounterPolarity = "beneficial" | "detrimental";

export interface Counter {
  name: string;
  count: number;
  semantics: CounterSemantics;
  /**
   * Needed for Mass Increment (spec §4): incrementing "all beneficial counters" on
   * an ally vs. "all detrimental counters" on an enemy requires knowing each
   * counter's polarity rather than inferring it from name or effect — inference
   * breaks down for bespoke counters with mixed or non-obvious effects. Built-ins
   * are tagged below; bespoke/generic counters (not yet reworked, per spec) will
   * need this tagged at their point of definition once they exist.
   */
  polarity: CounterPolarity;
}

export const BUILTIN_COUNTER_NAMES = ["+1/+1", "-1/-1", "shield", "plating", "poison"] as const;
export type BuiltinCounterName = (typeof BUILTIN_COUNTER_NAMES)[number];

export function counterSemantics(name: string): CounterSemantics {
  return (BUILTIN_COUNTER_NAMES as readonly string[]).includes(name) ? "builtin" : "generic";
}

const BUILTIN_COUNTER_POLARITY: Record<BuiltinCounterName, CounterPolarity> = {
  "+1/+1": "beneficial",
  "-1/-1": "detrimental",
  shield: "beneficial",
  plating: "beneficial",
  poison: "detrimental",
};

/** Only meaningful for built-ins — generic/bespoke counters must carry their own
 *  polarity at the point they're defined, since the engine has no way to infer it. */
export function builtinCounterPolarity(name: BuiltinCounterName): CounterPolarity {
  return BUILTIN_COUNTER_POLARITY[name];
}

export type Duration =
  | { kind: "untilNextCombat" }
  | { kind: "untilEoT" }
  | { kind: "untilEndOfCombat" }
  | { kind: "untilNextSoT" }
  | { kind: "untilPhaseIn" }
  | { kind: "untilCondition"; expr: unknown } // ConditionExpr, defined alongside the resolution engine
  | { kind: "permanent" };
