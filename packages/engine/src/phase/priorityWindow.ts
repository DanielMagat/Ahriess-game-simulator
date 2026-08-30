// Generic "alternating priority window" — see GAME_ENGINE_SPEC.md §6.
//
// Turn Priority, Repositioning, and Trap Placement are all structurally the same
// procedure: players alternate taking an action or passing, starting with a given
// player, until both players pass consecutively — they differ only in *which*
// actions are legal and what a pass costs. This is implemented once and parameterized.

export type PlayerId = string;

export interface PriorityWindowState {
  priorityPlayerId: PlayerId;
  consecutivePasses: number;
}

export interface PriorityWindowRules<TAction> {
  /** Whether the given player is currently allowed to pass. The attack-token holder,
   *  for instance, cannot pass in Turn Priority until the token is spent. */
  canPass(playerId: PlayerId): boolean;
  /** Whether a given action is legal for the given player right now. */
  isLegalAction(playerId: PlayerId, action: TAction): boolean;
}

export function startPriorityWindow(startingPlayerId: PlayerId): PriorityWindowState {
  return { priorityPlayerId: startingPlayerId, consecutivePasses: 0 };
}

export function isWindowComplete(state: PriorityWindowState): boolean {
  return state.consecutivePasses >= 2;
}

/** Advances the window after a player takes a real action (not a pass): priority
 *  passes to the opponent and the consecutive-pass counter resets. */
export function afterAction(state: PriorityWindowState, otherPlayerId: PlayerId): PriorityWindowState {
  return { priorityPlayerId: otherPlayerId, consecutivePasses: 0 };
}

/** Advances the window after a player passes: priority passes to the opponent and
 *  the consecutive-pass counter increments. Two in a row ends the window. */
export function afterPass(state: PriorityWindowState, otherPlayerId: PlayerId): PriorityWindowState {
  return { priorityPlayerId: otherPlayerId, consecutivePasses: state.consecutivePasses + 1 };
}
