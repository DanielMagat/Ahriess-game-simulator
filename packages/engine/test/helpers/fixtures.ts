import type { MatchState, CardInstance, BattlefieldUnit } from "../../src/types/state.js";
import type { DefinitionLookup } from "../../src/resolution/actions.js";

export function makeMatchState(laneIds: string[] = ["lane1", "lane2"]): MatchState {
  return {
    turnNumber: 1,
    activePlayerId: "P1",
    attackTokenHolderId: "P1",
    attackTokenSpentThisTurn: false,
    phase: "MainPhase",
    priorityPlayerId: "P1",
    consecutivePasses: 0,
    rngSeed: 0,
    eventLog: [],
    players: {
      P1: {
        id: "P1",
        energy: { current: 5, max: 5 },
        influence: { E: 0, S: 0, I: 0, B: 0 },
        zones: { deck: [], hand: [], graveyard: [] },
      },
      P2: {
        id: "P2",
        energy: { current: 5, max: 5 },
        influence: { E: 0, S: 0, I: 0, B: 0 },
        zones: { deck: [], hand: [], graveyard: [] },
      },
    },
    lanes: laneIds.map((id) => ({
      id,
      locationId: `${id}-location`,
      baseHealth: { P1: 10, P2: 10 },
      attackSequence: { P1: [], P2: [] },
      structures: { P1: [], P2: [] },
    })),
    triggerQueue: [],
    globalTrapStack: [],
    cardInstances: {},
    units: {},
  };
}

/** A DefinitionLookup backed by a plain map the test builds up alongside state,
 *  standing in for the real card database until card loading exists (see
 *  actions.ts's DefinitionLookup doc comment for why this is injected rather than
 *  assumed). Kept separate from MatchState itself rather than smuggled onto it. */
export class TestStatsRegistry implements DefinitionLookup {
  private stats = new Map<string, { power?: number; toughness?: number }>();

  set(instanceId: string, stats: { power?: number; toughness?: number }) {
    this.stats.set(instanceId, stats);
  }

  getBaseStats(instance: CardInstance) {
    return this.stats.get(instance.instanceId) ?? {};
  }
}

/** Adds a simple vanilla Unit to the battlefield: a CardInstance, a BattlefieldUnit,
 *  and an entry in its lane's attackSequence, all at once — the three places a
 *  battlefield object's data actually lives (spec §5). Registers its base stats
 *  with the given registry so computeCurrentStats can find them. */
export function addUnit(
  state: MatchState,
  registry: TestStatsRegistry,
  opts: { instanceId: string; controllerId: string; laneId: string; power: number; toughness: number; damage?: number }
): MatchState {
  const instance: CardInstance = {
    instanceId: opts.instanceId,
    origin: { kind: "token", tokenDefId: `${opts.instanceId}-def` },
    countersByMode: { A: [], B: [] },
    activeMode: "A",
  };
  const unit: BattlefieldUnit = {
    instanceId: opts.instanceId,
    controllerId: opts.controllerId,
    laneId: opts.laneId,
    damage: opts.damage ?? 0,
    statusEffects: [],
  };
  registry.set(opts.instanceId, { power: opts.power, toughness: opts.toughness });
  return {
    ...state,
    cardInstances: { ...state.cardInstances, [opts.instanceId]: instance },
    units: { ...state.units, [opts.instanceId]: unit },
    lanes: state.lanes.map((lane) =>
      lane.id === opts.laneId
        ? {
            ...lane,
            attackSequence: {
              ...lane.attackSequence,
              [opts.controllerId]: [...(lane.attackSequence[opts.controllerId] ?? []), opts.instanceId],
            },
          }
        : lane
    ),
  };
}
