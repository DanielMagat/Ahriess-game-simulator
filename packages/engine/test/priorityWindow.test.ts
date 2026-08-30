import { describe, it, expect } from "vitest";
import { startPriorityWindow, isWindowComplete, afterAction, afterPass } from "../src/phase/priorityWindow.js";

describe("priority window — attack token holder cannot pass until spent", () => {
  it("the turn cannot end via double-pass while the token holder still has an unspent token", () => {
    const holder = "P1";
    const other = "P2";
    let tokenSpent = false;
    const canPass = (playerId: string) => playerId !== holder || tokenSpent;

    let state = startPriorityWindow(holder);

    // Holder cannot pass yet — must act. Suppose they play a card.
    expect(canPass(state.priorityPlayerId)).toBe(false);
    state = afterAction(state, other);

    // Opponent (never holds the token) can always pass.
    expect(canPass(state.priorityPlayerId)).toBe(true);
    state = afterPass(state, holder);
    expect(isWindowComplete(state)).toBe(false); // only one pass so far

    // Holder still can't pass — forced to act (e.g. initiate combat, spending the token).
    expect(canPass(state.priorityPlayerId)).toBe(false);
    tokenSpent = true; // combat initiated
    state = afterAction(state, other);

    // Now that the token is spent, the former holder can pass like anyone else.
    expect(canPass(holder)).toBe(true);
    state = afterPass(state, holder);
    state = afterPass(state, other);
    expect(isWindowComplete(state)).toBe(true);
  });
});
