// Immutable-update helpers over MatchState. MatchState's nested Records make raw
// spread-everywhere verbose and error-prone to get right at every call site — these
// centralize the common patterns once instead. Consistent with the rest of the
// engine's functional style (turnMachine.ts, combatResolution.ts): state in, state
// out, no mutation of the input.

import type { MatchState, BattlefieldUnit, CardInstance } from "../types/state.js";
import type { Counter } from "../types/cards.js";

export function updateUnit(
  state: MatchState,
  instanceId: string,
  updater: (u: BattlefieldUnit) => BattlefieldUnit
): MatchState {
  const existing = state.units[instanceId];
  if (!existing) return state; // no-op if it's not (or no longer) on the battlefield
  return { ...state, units: { ...state.units, [instanceId]: updater(existing) } };
}

export function updateInstance(
  state: MatchState,
  instanceId: string,
  updater: (i: CardInstance) => CardInstance
): MatchState {
  const existing = state.cardInstances[instanceId];
  if (!existing) return state;
  return { ...state, cardInstances: { ...state.cardInstances, [instanceId]: updater(existing) } };
}

export function updateBaseHealth(state: MatchState, laneId: string, playerId: string, delta: number): MatchState {
  return {
    ...state,
    lanes: state.lanes.map((lane) =>
      lane.id === laneId
        ? { ...lane, baseHealth: { ...lane.baseHealth, [playerId]: (lane.baseHealth[playerId] ?? 0) + delta } }
        : lane
    ),
  };
}

/** The counter pool that's actually "live" for an instance right now — i.e. the
 *  one matching its current activeMode. See CardInstance's doc comment in state.ts
 *  for why counters are split per-mode in the first place. */
export function activeCounters(instance: CardInstance): Counter[] {
  return instance.countersByMode[instance.activeMode];
}

export function withActiveCounters(instance: CardInstance, counters: Counter[]): CardInstance {
  return { ...instance, countersByMode: { ...instance.countersByMode, [instance.activeMode]: counters } };
}

/** Adds to an existing counter of the same name if present, otherwise creates one.
 *  Amount may be negative (used by removeCounter) — a counter reduced to 0 or below
 *  is dropped entirely, not left at a negative/zero count. */
export function adjustCounter(
  state: MatchState,
  instanceId: string,
  counterName: string,
  amount: number,
  polarity: "beneficial" | "detrimental",
  semantics: "builtin" | "generic"
): MatchState {
  return updateInstance(state, instanceId, (instance) => {
    const current = activeCounters(instance);
    const existingIdx = current.findIndex((c) => c.name === counterName);
    if (existingIdx === -1) {
      if (amount <= 0) return instance; // nothing to remove from a counter that isn't there
      return withActiveCounters(instance, [...current, { name: counterName, count: amount, semantics, polarity }]);
    }
    const newCount = current[existingIdx].count + amount;
    const next =
      newCount <= 0
        ? current.filter((_, i) => i !== existingIdx)
        : current.map((c, i) => (i === existingIdx ? { ...c, count: newCount } : c));
    return withActiveCounters(instance, next);
  });
}

/** Moves a card instance from wherever it's tracked in one player's zones to
 *  another (e.g. hand -> graveyard on death/discard). No-ops if it isn't found in
 *  the "from" zone — callers are expected to know where something actually is;
 *  this just centralizes the array surgery. */
export function moveBetweenZones(
  state: MatchState,
  playerId: string,
  instanceId: string,
  from: "deck" | "hand" | "graveyard",
  to: "deck" | "hand" | "graveyard"
): MatchState {
  const player = state.players[playerId];
  if (!player) return state;
  const fromList = player.zones[from];
  if (!fromList.includes(instanceId)) return state;
  return {
    ...state,
    players: {
      ...state.players,
      [playerId]: {
        ...player,
        zones: {
          ...player.zones,
          [from]: fromList.filter((id) => id !== instanceId),
          [to]: [...player.zones[to], instanceId],
        },
      },
    },
  };
}

/** Removes a unit from the battlefield entirely: out of its lane's attack sequence
 *  AND structures list (a multi-typed object could be in both — see spec §5),
 *  its BattlefieldUnit overlay dropped, and (per the zone-change rule, spec §4) its
 *  damage discarded while its CardInstance/counters persist. Does NOT decide which
 *  zone it goes to — that's the caller's job (destroy -> graveyard, exile ->
 *  nowhere tracked yet, etc.), since that varies by action. */
export function removeFromBattlefield(state: MatchState, instanceId: string): MatchState {
  const unit = state.units[instanceId];
  if (!unit) return state;
  const { [instanceId]: _removed, ...remainingUnits } = state.units;
  return {
    ...state,
    units: remainingUnits,
    lanes: state.lanes.map((lane) => {
      if (lane.id !== unit.laneId) return lane;
      const stripFrom = (rec: Record<string, string[]>) =>
        Object.fromEntries(Object.entries(rec).map(([pid, ids]) => [pid, ids.filter((id) => id !== instanceId)]));
      return { ...lane, attackSequence: stripFrom(lane.attackSequence), structures: stripFrom(lane.structures) };
    }),
  };
}

/** The common case built on top of removeFromBattlefield: destroy, sacrifice, and
 *  lethal-damage state-based death all end the same way — off the battlefield, into
 *  its controller's graveyard, counters/identity intact (per the zone-change rule),
 *  damage discarded. */
export function moveFromBattlefieldToGraveyard(state: MatchState, instanceId: string): MatchState {
  const unit = state.units[instanceId];
  if (!unit) return state;
  const next = removeFromBattlefield(state, instanceId);
  const player = next.players[unit.controllerId];
  if (!player) return next;
  return {
    ...next,
    players: {
      ...next.players,
      [unit.controllerId]: {
        ...player,
        zones: { ...player.zones, graveyard: [...player.zones.graveyard, instanceId] },
      },
    },
  };
}
