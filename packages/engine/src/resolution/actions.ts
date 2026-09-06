// Action execution — see GAME_ENGINE_SPEC.md §4. Implements a representative
// subset of the primitive list (dealDamage, heal, addCounter, removeCounter,
// buffStat, freeze, draw, destroy, sacrifice) rather than all of them — enough to
// exercise the target-snapshot machinery (abilityQueue.ts) meaningfully. The rest
// follow the same pattern once needed; nothing here is architecturally special
// about the ones chosen.

import type { MatchState, CardInstance } from "../types/state.js";
import type { Action, ObjectRef, ZoneLocation, SearchCriteria } from "../types/abilities.js";
import {
  counterSemantics,
  builtinCounterPolarity,
  BuiltinCounterName,
  CardType,
  CounterPolarity,
} from "../types/cards.js";
import { EffectContext } from "./targeting.js";
import {
  updateUnit,
  adjustCounter,
  activeCounters,
  moveFromBattlefieldToGraveyard,
  removeFromBattlefield,
} from "./stateHelpers.js";

export type ResolutionEvent = { type: string; [key: string]: unknown };

/**
 * Everything about a SPECIFIC mode of an instance's underlying definition — cost,
 * stats, types — independent of which mode is currently active. Injected rather
 * than assumed, because computing it needs the card database, which doesn't
 * exist yet (roadmap: "card loading from data"). Tests supply a small fake; real
 * card loading supplies the real thing later without this module changing.
 */
export interface ModeInfo {
  cost?: { energy?: number; influence: { E: number; S: number; I: number; B: number; wildcard: number } };
  power?: number;
  toughness?: number;
  types: CardType[];
}

export interface DefinitionLookup {
  /**
   * One entry point rather than several narrower ones (this interface used to
   * have separate getBaseStats/getBaseTypes methods, each implicitly meaning
   * "for the current mode") because `search` needs to ask about BOTH of a card's
   * modes independently, not just whichever is currently active — see the
   * `search` Action's doc comment in abilities.ts. `computeCurrentStats`/
   * `computeCurrentTypes` below just call this with `instance.activeMode`.
   * Tokens/fusions, which don't have two real modes, should return equivalent
   * info for both "A" and "B" (whichever matches their fixed tag) — a caller
   * asking about the "other" side simply won't find a match, which is correct:
   * a token doesn't have a second mode to be found under.
   */
  getModeInfo(instance: CardInstance, mode: "A" | "B"): ModeInfo | undefined;
}

const EMPTY_DEFINITIONS: DefinitionLookup = {
  getModeInfo: () => undefined,
};

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

  const modeInfo = definitions.getModeInfo(instance, instance.activeMode);
  let power = modeInfo?.power;
  let toughness = modeInfo?.toughness;

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

/**
 * Base types from the instance's definition, with any active `changeCardType`
 * overlays applied in the order they were added — mirrors computeCurrentStats'
 * pattern exactly (derive, don't store; see BattlefieldUnit's doc comment and
 * the `typeOverride` StatusEffect in state.ts).
 */
export function computeCurrentTypes(state: MatchState, instanceId: string, definitions: DefinitionLookup): CardType[] {
  const instance = state.cardInstances[instanceId];
  const unit = state.units[instanceId];
  if (!instance || !unit) return [];

  let types = definitions.getModeInfo(instance, instance.activeMode)?.types ?? [];
  for (const status of unit.statusEffects) {
    if (status.kind === "typeOverride") {
      types = types.filter((t) => !status.from.includes(t));
      for (const t of status.to) {
        if (!types.includes(t)) types.push(t);
      }
    }
  }
  return types;
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

/**
 * changeCardType (spec §4): effective types become (current types − from) ∪ to,
 * then — since board membership (attackSequence/structures — spec §5) is the
 * actual source of truth for "does this fight in combat," not a type field
 * anyone queries live — gaining or losing Unit/Structure-ness immediately adds or
 * removes the object from the relevant list(s), same as the doc comment on the
 * Action type promises. A no-op if the target isn't on the battlefield (nothing
 * to change membership of; changeCardType targeting non-battlefield objects
 * isn't a case any current card needs).
 */
function applyChangeCardType(
  state: MatchState,
  instanceId: string,
  from: CardType[],
  to: CardType[],
  definitions: DefinitionLookup
): { state: MatchState; events: ResolutionEvent[] } {
  const events: ResolutionEvent[] = [];
  const unit = state.units[instanceId];
  if (!unit) return { state, events };

  const before = computeCurrentTypes(state, instanceId, definitions);

  let next = updateUnit(state, instanceId, (u) => ({
    ...u,
    statusEffects: [
      ...u.statusEffects,
      { kind: "typeOverride" as const, from, to, expiresAt: { kind: "permanent" as const } },
    ],
  }));

  const after = computeCurrentTypes(next, instanceId, definitions);
  events.push({ type: "typeChanged", target: instanceId, before, after });

  const gainedUnit = after.includes("Unit") && !before.includes("Unit");
  const lostUnit = before.includes("Unit") && !after.includes("Unit");
  const gainedStructure = after.includes("Structure") && !before.includes("Structure");
  const lostStructure = before.includes("Structure") && !after.includes("Structure");

  if (gainedUnit || lostUnit || gainedStructure || lostStructure) {
    next = {
      ...next,
      lanes: next.lanes.map((lane) => {
        if (lane.id !== unit.laneId) return lane;
        const seq = lane.attackSequence[unit.controllerId] ?? [];
        const structs = lane.structures[unit.controllerId] ?? [];
        const newSeq =
          gainedUnit && !seq.includes(instanceId)
            ? [...seq, instanceId] // appended to the END, same as any other new Unit — spec §3
            : lostUnit
              ? seq.filter((id) => id !== instanceId)
              : seq;
        const newStructs =
          gainedStructure && !structs.includes(instanceId)
            ? [...structs, instanceId]
            : lostStructure
              ? structs.filter((id) => id !== instanceId)
              : structs;
        return {
          ...lane,
          attackSequence: { ...lane.attackSequence, [unit.controllerId]: newSeq },
          structures: { ...lane.structures, [unit.controllerId]: newStructs },
        };
      }),
    };
  }

  return { state: next, events };
}

/**
 * massIncrement (spec §4): polarity, not a fixed counter list, decides what gets
 * bumped — beneficial counters on an ally (relative to the effect's controller,
 * `ctx.controllerId`, NOT the target's own perspective), detrimental ones on an
 * enemy. Only touches counters the target ALREADY has; it never creates a new
 * counter from nothing, matching the spec's "increasing all of the beneficial
 * counters ON IT" phrasing. Because every Counter already carries its own
 * `polarity` (builtin or generic alike — see cards.ts), this needs no per-name
 * lookup or generic-counter special-casing the way addCounter/removeCounter do:
 * it just reads whatever's already there. A no-op if the target isn't currently
 * on the battlefield (mass increment reads a live ally/enemy relationship, which
 * only means something for something actually in a lane right now).
 */
function massIncrementTarget(
  state: MatchState,
  instanceId: string,
  effectControllerId: string
): { state: MatchState; events: ResolutionEvent[] } {
  const events: ResolutionEvent[] = [];
  const unit = state.units[instanceId];
  const instance = state.cardInstances[instanceId];
  if (!unit || !instance) return { state, events };

  const polarity: CounterPolarity = unit.controllerId === effectControllerId ? "beneficial" : "detrimental";
  const toIncrement = activeCounters(instance).filter((c) => c.polarity === polarity);

  let next = state;
  for (const counter of toIncrement) {
    next = adjustCounter(next, instanceId, counter.name, 1, counter.polarity, counter.semantics);
  }
  events.push({
    type: "massIncremented",
    target: instanceId,
    polarity,
    counterNames: toIncrement.map((c) => c.name),
  });
  return { state: next, events };
}

function gainEnergyFor(state: MatchState, playerId: string, amount: number, temporary: boolean): MatchState {
  const player = state.players[playerId];
  if (!player) return state;
  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: {
        ...player,
        // Temporary: current only, doesn't persist as max (spec §3) — can push
        // current above max, same as e.g. a one-turn mana boost in comparable
        // games. Permanent: both current and max go up together, mirroring the
        // natural "+1 max, refill to max" start-of-turn step.
        energy: temporary
          ? { ...player.energy, current: player.energy.current + amount }
          : { current: player.energy.current + amount, max: player.energy.max + amount },
      },
    },
  };
}

function gainInfluenceFor(
  state: MatchState,
  playerId: string,
  color: "E" | "S" | "I" | "B",
  amount: number
): MatchState {
  const player = state.players[playerId];
  if (!player) return state;
  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: { ...player, influence: { ...player.influence, [color]: player.influence[color] + amount } },
    },
  };
}

function spendInfluenceFor(
  state: MatchState,
  playerId: string,
  color: "E" | "S" | "I" | "B",
  amount: number
): MatchState {
  const player = state.players[playerId];
  if (!player) return state;
  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: {
        ...player,
        // Clamped at 0 defensively — this primitive doesn't itself check
        // affordability (that's presumably enforced upstream, wherever a cost is
        // paid), so a negative pool would be a silent bug rather than a real
        // game state if something ever called this for more than the player has.
        influence: { ...player.influence, [color]: Math.max(0, player.influence[color] - amount) },
      },
    },
  };
}

/** discard operates on the hand zone specifically, so — unlike battlefield
 *  targets, whose controller is right there on BattlefieldUnit — this has to
 *  search for which player currently has the card in hand at all (CardInstance
 *  itself carries no owner/controller field; zone membership IS the only record
 *  of whose hand something is in). Returns undefined if it's not in anyone's
 *  hand right now (already moved elsewhere by an earlier effect, etc.). */
function findHandOwner(state: MatchState, instanceId: string): string | undefined {
  return Object.keys(state.players).find((pid) => state.players[pid].zones.hand.includes(instanceId));
}

/**
 * The one general mechanism for moving a card/token between zones — hand,
 * graveyard, deck, exile, or the battlefield (in a specific lane) on either
 * side. `discard`/`exile`/`returnToHand`/the generic `moveZone` Action, and
 * (once it exists) "playing a card," all delegate to this rather than
 * duplicating battlefield-entry/exit logic three-plus times over — per the
 * game designer's own suggested shape: paying a cost and choosing a lane are
 * the caller's job; this is just "move the card," reusable regardless of what
 * decided the destination.
 *
 * The two zone KINDS are handled asymmetrically because they genuinely behave
 * differently, not as an arbitrary special case:
 * - Leaving the battlefield: tears the BattlefieldUnit down entirely. This IS
 *   the zone-change rule (spec §5) — damage lives only on BattlefieldUnit, so
 *   it's simply gone once that's deleted; counters live on CardInstance,
 *   completely untouched here, so they survive automatically.
 * - Entering the battlefield: creates a fresh BattlefieldUnit (damage: 0, no
 *   status effects), commits a mode into CardInstance.activeMode (`to.mode` if
 *   given, otherwise whatever the instance's mode already was — e.g. a
 *   recursion effect bringing something back as what it last was), and adds the
 *   instance to its new lane's attackSequence and/or structures per its
 *   effective types — the same membership rule changeCardType's handler uses
 *   (see applyChangeCardType above), just for a fresh entry rather than a diff.
 * - Any other zone-to-zone move (hand/graveyard/deck/exile, any combination) is
 *   just relocating one id between two arrays; nothing about the card's own
 *   state changes at all.
 *
 * A card with no resolvable mode when entering the battlefield (no `to.mode`
 * given AND no pre-existing `activeMode` — shouldn't happen, since every
 * CardInstance is created with one, but guarded rather than assumed) emits
 * `enterBattlefieldModeUnresolved` and stops rather than guessing a mode.
 */
export function moveZone(
  state: MatchState,
  instanceId: string,
  from: ZoneLocation,
  to: ZoneLocation,
  definitions: DefinitionLookup = EMPTY_DEFINITIONS
): { state: MatchState; events: ResolutionEvent[] } {
  const events: ResolutionEvent[] = [];
  let next = state;

  if (from.kind === "battlefield") {
    if (!next.units[instanceId]) {
      events.push({ type: "moveZoneSourceMissing", target: instanceId });
      return { state: next, events };
    }
    next = removeFromBattlefield(next, instanceId);
  } else {
    const player = next.players[from.playerId];
    if (!player || !player.zones[from.kind].includes(instanceId)) {
      events.push({ type: "moveZoneSourceMissing", target: instanceId });
      return { state: next, events };
    }
    next = {
      ...next,
      players: {
        ...next.players,
        [from.playerId]: {
          ...player,
          zones: { ...player.zones, [from.kind]: player.zones[from.kind].filter((id) => id !== instanceId) },
        },
      },
    };
  }

  if (to.kind === "battlefield") {
    const instance = next.cardInstances[instanceId];
    const mode = to.mode ?? instance?.activeMode;
    if (!instance || !mode) {
      events.push({ type: "enterBattlefieldModeUnresolved", target: instanceId });
      return { state: next, events };
    }
    if (instance.activeMode !== mode) {
      next = { ...next, cardInstances: { ...next.cardInstances, [instanceId]: { ...instance, activeMode: mode } } };
    }
    next = {
      ...next,
      units: {
        ...next.units,
        [instanceId]: { instanceId, controllerId: to.playerId, laneId: to.laneId, damage: 0, statusEffects: [] },
      },
    };
    const types = computeCurrentTypes(next, instanceId, definitions);
    next = {
      ...next,
      lanes: next.lanes.map((lane) => {
        if (lane.id !== to.laneId) return lane;
        const seq = lane.attackSequence[to.playerId] ?? [];
        const structs = lane.structures[to.playerId] ?? [];
        return {
          ...lane,
          attackSequence: {
            ...lane.attackSequence,
            [to.playerId]: types.includes("Unit") && !seq.includes(instanceId) ? [...seq, instanceId] : seq,
          },
          structures: {
            ...lane.structures,
            [to.playerId]:
              types.includes("Structure") && !structs.includes(instanceId) ? [...structs, instanceId] : structs,
          },
        };
      }),
    };
    events.push({ type: "enteredBattlefield", target: instanceId, playerId: to.playerId, laneId: to.laneId, mode });
  } else {
    const player = next.players[to.playerId];
    if (player) {
      next = {
        ...next,
        players: {
          ...next.players,
          [to.playerId]: { ...player, zones: { ...player.zones, [to.kind]: [...player.zones[to.kind], instanceId] } },
        },
      };
    }
    events.push({ type: "zoneChanged", target: instanceId, to: to.kind, playerId: to.playerId });
  }

  return { state: next, events };
}

/**
 * Moves a unit already on the battlefield to a DIFFERENT lane on the SAME
 * battlefield — NOT the same thing as moveZone (which is about zone KIND, not
 * position within the battlefield). Always appends to the end of the new lane's
 * attack sequence, regardless of how it got there (spec §3). Deliberately does
 * NO adjacency or legality checking — that's the caller's job. During normal
 * play that's turnMachine.ts's dedicated Repositioning handling (adjacency via
 * lanes.ts, charge cost, whose turn it is); this function just performs a move
 * it's already been told is legal, so it's equally usable from a card effect
 * that resolved its own destination some other way.
 */
function moveUnitToLane(
  state: MatchState,
  instanceId: string,
  toLaneId: string,
  definitions: DefinitionLookup = EMPTY_DEFINITIONS
): { state: MatchState; events: ResolutionEvent[] } {
  const events: ResolutionEvent[] = [];
  const unit = state.units[instanceId];
  if (!unit) return { state, events };
  const fromLaneId = unit.laneId;
  if (fromLaneId === toLaneId) return { state, events };

  const types = computeCurrentTypes(state, instanceId, definitions);
  let next: MatchState = { ...state, units: { ...state.units, [instanceId]: { ...unit, laneId: toLaneId } } };
  next = {
    ...next,
    lanes: next.lanes.map((lane) => {
      if (lane.id === fromLaneId) {
        return {
          ...lane,
          attackSequence: {
            ...lane.attackSequence,
            [unit.controllerId]: (lane.attackSequence[unit.controllerId] ?? []).filter((id) => id !== instanceId),
          },
          structures: {
            ...lane.structures,
            [unit.controllerId]: (lane.structures[unit.controllerId] ?? []).filter((id) => id !== instanceId),
          },
        };
      }
      if (lane.id === toLaneId) {
        const seq = lane.attackSequence[unit.controllerId] ?? [];
        const structs = lane.structures[unit.controllerId] ?? [];
        return {
          ...lane,
          attackSequence: {
            ...lane.attackSequence,
            [unit.controllerId]: types.includes("Unit") ? [...seq, instanceId] : seq,
          },
          structures: {
            ...lane.structures,
            [unit.controllerId]: types.includes("Structure") ? [...structs, instanceId] : structs,
          },
        };
      }
      return lane;
    }),
  };
  events.push({ type: "unitMoved", target: instanceId, fromLaneId, toLaneId });
  return { state: next, events };
}

function matchesSearchCriteria(info: ModeInfo | undefined, criteria: SearchCriteria): boolean {
  if (!info) return false;
  if (criteria.type && !info.types.includes(criteria.type)) return false;
  if (criteria.cost) {
    const energy = info.cost?.energy;
    if (energy === undefined) return false; // Traps have no energy cost — never match a cost criterion
    if (criteria.cost.op === "eq" && energy !== criteria.cost.value) return false;
    if (criteria.cost.op === "gt" && !(energy > criteria.cost.value)) return false;
    if (criteria.cost.op === "lt" && !(energy < criteria.cost.value)) return false;
  }
  return true;
}

export interface SearchMatch {
  instanceId: string;
  /** Which mode(s) of this card satisfy the criteria, checked independently —
   *  see the `search` Action's doc comment (abilities.ts) for why this matters:
   *  entering the battlefield must commit to a mode that actually matched. */
  matchingModes: ("A" | "B")[];
}

/** Pure query logic, kept separate from the `search` Action case below so it's
 *  independently testable — checks every instance in `instanceIds` against
 *  `criteria` under BOTH of its modes (spec confirmed: search always checks
 *  both, and must return which specific mode(s) matched, not just "yes/no"). */
export function evaluateSearchQuery(
  state: MatchState,
  instanceIds: string[],
  criteria: SearchCriteria,
  definitions: DefinitionLookup
): SearchMatch[] {
  const results: SearchMatch[] = [];
  for (const instanceId of instanceIds) {
    const instance = state.cardInstances[instanceId];
    if (!instance) continue;
    const matchingModes = (["A", "B"] as const).filter((mode) =>
      matchesSearchCriteria(definitions.getModeInfo(instance, mode), criteria)
    );
    if (matchingModes.length > 0) results.push({ instanceId, matchingModes });
  }
  return results;
}

export function executeAction(
  state: MatchState,
  action: Action,
  ctx: EffectContext,
  targets: ObjectRef[],
  /**
   * Optional (defaults to an empty lookup returning no stats/types) so the ~50
   * existing call sites that don't touch anything type-aware — every test
   * written before changeCardType existed — keep working unchanged. Only
   * changeCardType actually reads this; everything else ignores the parameter
   * entirely. Real resolution (resolveQueuedAbility, abilityQueue.ts) always
   * passes the real one through.
   */
  definitions: DefinitionLookup = EMPTY_DEFINITIONS
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
      for (const t of targets) {
        const unit = next.units[t.objectId];
        if (!unit) continue;
        const result = moveZone(
          next,
          t.objectId,
          { kind: "battlefield", playerId: unit.controllerId, laneId: unit.laneId },
          { kind: "exile", playerId: unit.controllerId },
          definitions
        );
        next = result.state;
        events.push(...result.events);
        if (!result.events.some((e) => e.type === "moveZoneSourceMissing")) {
          events.push({ type: "exiled", target: t.objectId, playerId: unit.controllerId });
        }
      }
      return { state: next, events };

    case "discard":
      for (const t of targets) {
        // Only handles the case where targets were actually resolved (e.g. a
        // targeted "discard target card" or an automatic "discard each card
        // matching X" via the ability's own TargetSpec). An untargeted "discard N
        // of your choice" — no ability-level target, count only — needs a player
        // choice of which N, which isn't a target-selection decision (§7's
        // locked/liveScope split doesn't cover it) and isn't implemented; that
        // shape correctly falls through to here with an empty targets array and
        // does nothing, rather than guessing which cards to discard.
        const ownerId = findHandOwner(next, t.objectId);
        if (!ownerId) continue; // not actually in anyone's hand right now
        const result = moveZone(
          next,
          t.objectId,
          { kind: "hand", playerId: ownerId },
          { kind: "graveyard", playerId: ownerId },
          definitions
        );
        next = result.state;
        events.push(...result.events);
        if (!result.events.some((e) => e.type === "moveZoneSourceMissing")) {
          events.push({ type: "discarded", target: t.objectId, playerId: ownerId });
        }
      }
      return { state: next, events };

    case "returnToHand":
      for (const t of targets) {
        const unit = next.units[t.objectId];
        if (!unit) continue; // not on the battlefield
        const result = moveZone(
          next,
          t.objectId,
          { kind: "battlefield", playerId: unit.controllerId, laneId: unit.laneId },
          { kind: "hand", playerId: unit.controllerId },
          definitions
        );
        next = result.state;
        events.push(...result.events);
        if (!result.events.some((e) => e.type === "moveZoneSourceMissing")) {
          events.push({ type: "returnedToHand", target: t.objectId, playerId: unit.controllerId });
        }
      }
      return { state: next, events };

    case "moveZone":
      for (const t of targets) {
        const result = moveZone(next, t.objectId, action.from, action.to, definitions);
        next = result.state;
        events.push(...result.events);
      }
      return { state: next, events };

    case "moveUnit":
      for (const t of targets) {
        const result = moveUnitToLane(next, t.objectId, action.toLaneId, definitions);
        next = result.state;
        events.push(...result.events);
      }
      return { state: next, events };

    case "search": {
      // Defaults to the ability's own controller's zone — every confirmed
      // example ("search YOUR deck for...") is self-targeted; searching an
      // opponent's zone isn't a case this handles yet (would need a way to
      // express whose zone on the Action itself, which nothing currently asks
      // for — flag if a card needs it).
      const searcherId = ctx.controllerId;
      const player = next.players[searcherId];
      if (!player) return { state: next, events };
      const matches = evaluateSearchQuery(next, player.zones[action.zone], action.criteria, definitions);

      if (matches.length === 0) {
        events.push({ type: "searchFoundNothing" });
        return { state: next, events };
      }

      // Picking among MULTIPLE matching cards is a genuine player decision (deck
      // searches are browsed, not auto-picked) — same story for picking among
      // multiple matching MODES of a single card headed to the battlefield (see
      // the Action's doc comment). Neither has a decision-checkpoint mechanism to
      // ask through yet, so both are flagged rather than guessed. The
      // deterministic case — exactly one matching card, and (if headed to the
      // battlefield) exactly one matching mode — needs no decision and IS
      // implemented below.
      if (matches.length > 1) {
        events.push({ type: "searchNeedsDecision", reason: "multiple cards matched", matchCount: matches.length });
        return { state: next, events };
      }
      const match = matches[0];

      if (action.destination.kind === "hand") {
        const result = moveZone(
          next,
          match.instanceId,
          { kind: action.zone, playerId: searcherId },
          { kind: "hand", playerId: searcherId },
          definitions
        );
        next = result.state;
        events.push({ type: "searched", target: match.instanceId, destination: "hand" }, ...result.events);
        return { state: next, events };
      }

      if (match.matchingModes.length > 1) {
        events.push({
          type: "searchNeedsDecision",
          reason: "multiple modes of the matched card qualify",
          target: match.instanceId,
        });
        return { state: next, events };
      }
      const laneId = action.destination.laneId ?? ctx.sourceLaneId;
      if (!laneId) {
        events.push({
          type: "searchNeedsDecision",
          reason: "no destination lane resolvable",
          target: match.instanceId,
        });
        return { state: next, events };
      }
      const result = moveZone(
        next,
        match.instanceId,
        { kind: action.zone, playerId: searcherId },
        { kind: "battlefield", playerId: searcherId, laneId, mode: match.matchingModes[0] },
        definitions
      );
      next = result.state;
      events.push({ type: "searched", target: match.instanceId, destination: "battlefield" }, ...result.events);
      return { state: next, events };
    }

    case "changeCardType":
      for (const t of targets) {
        const result = applyChangeCardType(next, t.objectId, action.from, action.to, definitions);
        next = result.state;
        events.push(...result.events);
      }
      return { state: next, events };

    case "massIncrement":
      for (const t of targets) {
        const result = massIncrementTarget(next, t.objectId, ctx.controllerId);
        next = result.state;
        events.push(...result.events);
      }
      return { state: next, events };

    case "gainEnergy":
      next = gainEnergyFor(next, ctx.controllerId, action.amount, action.temporary);
      events.push({
        type: "energyGained",
        playerId: ctx.controllerId,
        amount: action.amount,
        temporary: action.temporary,
      });
      return { state: next, events };

    case "gainInfluence":
      if (action.color === "choice") {
        // Which color to gain is a genuine player decision, same principle as
        // §7's "a player choice is made when queued" — just not routed through
        // TargetSpec/queueAbility since this isn't a target choice at all, it's
        // an action parameter. No decision-checkpoint mechanism exists yet to
        // actually ask, so — consistent with everything else gated on that
        // mechanism — this is a visible no-op rather than a guessed color.
        events.push({ type: "colorChoiceNotImplemented", action: "gainInfluence" });
        return { state: next, events };
      }
      next = gainInfluenceFor(next, ctx.controllerId, action.color, action.amount);
      events.push({ type: "influenceGained", playerId: ctx.controllerId, color: action.color, amount: action.amount });
      return { state: next, events };

    case "spendInfluence":
      next = spendInfluenceFor(next, ctx.controllerId, action.color, action.amount);
      events.push({ type: "influenceSpent", playerId: ctx.controllerId, color: action.color, amount: action.amount });
      return { state: next, events };

    case "negate":
    case "modifyCost":
    case "copy":
    case "fuse":
    case "switchForm":
    case "createToken":
    case "transform":
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
      // living inside an all-catching default forever. Each of these is blocked
      // on something specific rather than just "not gotten to yet":
      //  - negate: the PURE checking logic exists and is tested —
      //    resolution/abilityAvailability.ts's isAbilityNegated — but nothing in
      //    the engine yet automatically fires SoT/EtB/Fall/etc. triggers at all
      //    (no trigger-dispatch loop exists), so there's no live caller for it.
      //    Storing the StatusEffect here without that consumer would be inert.
      //  - modifyCost: `scope`/`condition` are typed `unknown` — no defined
      //    shape for conditional cost-modification language yet; waiting on real
      //    card examples.
      //  - copy/fuse/switchForm/createToken/transform: all need a real
      //    CardDefinition/TokenDefinition registry to know what to copy, create,
      //    or switch to — blocked on "card loading from data" (roadmap, later).
      //  - chooseOne/chooseAnyNumber/lookAtTopN: explicitly resolution-time
      //    decision points per spec §4/§7 — waiting on the decision-checkpoint
      //    mechanism, not on anything specific to these three.
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
