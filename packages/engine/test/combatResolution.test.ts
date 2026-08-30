import { describe, it, expect } from "vitest";
import { resolveLaneCombat, CombatUnit, LaneCombatHooks, CombatRosters } from "../src/combat/combatResolution.js";

function makeUnit(id: string, opts: Partial<CombatUnit> = {}): CombatUnit {
  return { id, power: 1, toughness: 3, frozen: false, hasFirstStrike: false, ...opts };
}

function noopHooks(): LaneCombatHooks {
  return {
    dealDamageToBase() {},
    isLaneDeactivated: () => false,
    drainTriggersAndStatics() {},
  };
}

describe("resolveLaneCombat — basic loop-around, no deaths", () => {
  it("3 attackers vs 2 defenders: the 3rd attacker loops around to fight the 1st defender again", () => {
    const A = makeUnit("A");
    const B = makeUnit("B");
    const C = makeUnit("C");
    const u1 = makeUnit("1");
    const u2 = makeUnit("2");

    const events = resolveLaneCombat([A, B, C], [u1, u2], noopHooks());

    const mutualPairs = events.filter((e) => e.type === "mutualFight").map((e: any) => [e.a, e.b]);

    expect(mutualPairs).toEqual([
      ["A", "1"],
      ["B", "2"],
      ["C", "1"], // loop-around: 1 already had its turn, but is still alive and found again
    ]);
  });
});

describe("resolveLaneCombat — excess units distribute sequentially, not all onto the same defender", () => {
  it("4 attackers vs 2 defenders: the two excess attackers each get a DIFFERENT defender, not both hitting the first", () => {
    const A = makeUnit("A");
    const B = makeUnit("B");
    const C = makeUnit("C");
    const D = makeUnit("D");
    const u1 = makeUnit("1");
    const u2 = makeUnit("2");

    const events = resolveLaneCombat([A, B, C, D], [u1, u2], noopHooks());
    const mutualPairs = events.filter((e) => e.type === "mutualFight").map((e: any) => [e.a, e.b]);

    // Old (buggy) behavior would have produced [A,1],[B,2],[C,1],[D,1] — both excess
    // attackers piling onto "1" since it never leaves the search pool. Corrected
    // behavior distributes them: C gets 1, D gets 2.
    expect(mutualPairs).toEqual([
      ["A", "1"],
      ["B", "2"],
      ["C", "1"],
      ["D", "2"],
    ]);
  });

  it("5 attackers vs 2 defenders: a third excess attacker starts a fresh lap back at the first defender", () => {
    const A = makeUnit("A");
    const B = makeUnit("B");
    const C = makeUnit("C");
    const D = makeUnit("D");
    const E = makeUnit("E");
    const u1 = makeUnit("1");
    const u2 = makeUnit("2");

    const events = resolveLaneCombat([A, B, C, D, E], [u1, u2], noopHooks());
    const mutualPairs = events.filter((e) => e.type === "mutualFight").map((e: any) => [e.a, e.b]);

    expect(mutualPairs).toEqual([
      ["A", "1"],
      ["B", "2"],
      ["C", "1"], // first lap through the passive queue
      ["D", "2"],
      ["E", "1"], // passive queue drained after C,D — rebuilt fresh, second lap starts at 1 again
    ]);

    // Confirms the passive queue really was rebuilt twice (once per lap), not reused stale.
    expect(events.filter((e) => e.type === "passiveQueueBuilt")).toHaveLength(2);
  });
});

describe("resolveLaneCombat — death mid-combat spawns tokens that join the same combat", () => {
  it("matches the designer's worked example: A/B/C vs 1/2, 2 dies and spawns 3+4, C fights 3, 4 loops to A", () => {
    const A = makeUnit("A");
    const B = makeUnit("B");
    const C = makeUnit("C");
    const u1 = makeUnit("1");
    const u2 = makeUnit("2", { toughness: 1 }); // dies to a single hit

    let spawned = false;
    const hooks: LaneCombatHooks = {
      dealDamageToBase() {},
      isLaneDeactivated: () => false,
      drainTriggersAndStatics(rosters: CombatRosters) {
        if (!spawned && u2.toughness <= 0) {
          spawned = true;
          const t3 = makeUnit("3");
          const t4 = makeUnit("4");
          // New units are always appended to the end of the attack sequence, and join
          // this combat's turn order too, per the designer's confirmation.
          rosters.rosterB.push(t3, t4);
          rosters.activeB.push(t3, t4);
        }
      },
    };

    const events = resolveLaneCombat([A, B, C], [u1, u2], hooks);
    const mutualPairs = events.filter((e) => e.type === "mutualFight").map((e: any) => [e.a, e.b]);

    expect(mutualPairs).toEqual([
      ["A", "1"],
      ["B", "2"],
      ["C", "3"],
      ["4", "A"], // 4 loops around since B's side has nothing left in its own turn queue
    ]);
    expect(events).toContainEqual({ type: "unitDied", id: "2" });
  });

  it("frozen spawned tokens: C still fights frozen 3, but frozen 4 does not attempt to fight at all", () => {
    const A = makeUnit("A");
    const B = makeUnit("B");
    const C = makeUnit("C");
    const u1 = makeUnit("1");
    const u2 = makeUnit("2", { toughness: 1 });

    let spawned = false;
    const hooks: LaneCombatHooks = {
      dealDamageToBase() {},
      isLaneDeactivated: () => false,
      drainTriggersAndStatics(rosters: CombatRosters) {
        if (!spawned && u2.toughness <= 0) {
          spawned = true;
          const t3 = makeUnit("3", { frozen: true });
          const t4 = makeUnit("4", { frozen: true });
          rosters.rosterB.push(t3, t4);
          rosters.activeB.push(t3, t4);
        }
      },
    };

    const events = resolveLaneCombat([A, B, C], [u1, u2], hooks);

    // C vs 3 still happens as a real mutual fight (C deals damage; frozen 3 deals none)...
    expect(events).toContainEqual({ type: "mutualFight", a: "C", b: "3" });
    expect(events).toContainEqual({ type: "damage", source: "C", target: "3", amount: 1 });
    expect(events.filter((e) => e.type === "damage" && (e as any).source === "3")).toHaveLength(0);

    // ...but frozen 4 never attempts to fight anything at all.
    expect(events).toContainEqual({ type: "excessNoOp", source: "4", reason: "frozen" });
    expect(events.some((e) => e.type === "mutualFight" && ((e as any).a === "4" || (e as any).b === "4"))).toBe(false);
  });
});

describe("resolveLaneCombat — bidirectional freeze during a shared matchup", () => {
  it("both frozen: no fight event, but the flow continues and C still loops around normally", () => {
    const A = makeUnit("A");
    const B = makeUnit("B", { frozen: true });
    const C = makeUnit("C");
    const u1 = makeUnit("1");
    const u2 = makeUnit("2", { frozen: true });

    const events = resolveLaneCombat([A, B, C], [u1, u2], noopHooks());

    expect(events).toContainEqual({ type: "noFight", a: "B", b: "2", reason: "bothFrozen" });
    expect(
      events.filter((e) => e.type === "damage" && ((e as any).source === "B" || (e as any).target === "B"))
    ).toHaveLength(0);

    const mutualPairs = events.filter((e) => e.type === "mutualFight").map((e: any) => [e.a, e.b]);
    expect(mutualPairs).toEqual([
      ["A", "1"],
      ["B", "2"],
      ["C", "1"], // 2 already "used" its turn (even without fighting); C loops to 1, still alive
    ]);
  });

  it("one-sided freeze within a matchup: the non-frozen unit still deals damage, the frozen one doesn't", () => {
    const u = makeUnit("u", { frozen: true });
    const v = makeUnit("v");
    const events = resolveLaneCombat([u], [v], noopHooks());

    expect(events).toContainEqual({ type: "damage", source: "v", target: "u", amount: 1 });
    expect(events.filter((e) => e.type === "damage" && (e as any).source === "u")).toHaveLength(0);
  });
});

describe("resolveLaneCombat — first strike combined with an on-damage status effect", () => {
  it("'when this deals damage to a unit, freeze it' + first strike denies retaliation, with no first-strike-specific wiring for that effect", () => {
    const striker = makeUnit("striker", { hasFirstStrike: true, power: 1, toughness: 3 });
    const target = makeUnit("target", { hasFirstStrike: false, power: 5, toughness: 3 });

    // Simulates a card effect the engine has no built-in knowledge of: "when this
    // deals damage to a unit, freeze it." The generalized canDealDamage() check is
    // what makes this compose correctly with first strike, not any first-strike-
    // specific code path.
    const hooks: LaneCombatHooks = {
      dealDamageToBase() {},
      isLaneDeactivated: () => false,
      drainTriggersAndStatics() {
        if (target.toughness < 3 && !target.frozen) {
          target.frozen = true;
        }
      },
    };

    const events = resolveLaneCombat([striker], [target], hooks);

    expect(events).toContainEqual({ type: "damage", source: "striker", target: "target", amount: 1 });
    // If the retaliation weren't correctly suppressed, "target" (power 5) would have
    // dealt a damage event back to "striker" here.
    expect(events.filter((e) => e.type === "damage" && (e as any).source === "target")).toHaveLength(0);
  });
});

describe("resolveLaneCombat — shield/plating counters mitigate combat damage", () => {
  it("shield fully absorbs a combat hit and depletes by 1; no damage event, no death", () => {
    const attacker = makeUnit("attacker", { power: 5 });
    const defender = makeUnit("defender", { toughness: 1, shieldCount: 1 });

    const events = resolveLaneCombat([attacker], [defender], noopHooks());

    expect(events).toContainEqual({ type: "shieldPrevented", source: "attacker", target: "defender" });
    expect(events.some((e) => e.type === "damage" && (e as any).target === "defender")).toBe(false);
    expect(events.some((e) => e.type === "unitDied" && (e as any).id === "defender")).toBe(false);
    expect(defender.shieldCount).toBe(0);
  });

  it("plating reduces a combat hit by its count and depletes by exactly 1 regardless of how much it blocked", () => {
    const attacker = makeUnit("attacker", { power: 5 });
    const defender = makeUnit("defender", { toughness: 10, platingCount: 2 });

    const events = resolveLaneCombat([attacker], [defender], noopHooks());

    expect(events).toContainEqual({
      type: "platingReduced",
      source: "attacker",
      target: "defender",
      rawAmount: 5,
      reducedAmount: 3,
    });
    expect(events).toContainEqual({ type: "damage", source: "attacker", target: "defender", amount: 3 });
    expect(defender.platingCount).toBe(1);
    expect(defender.toughness).toBe(7);
  });

  it("units with no shield/plating fields behave exactly as before (default 0)", () => {
    const attacker = makeUnit("attacker", { power: 2 });
    const defender = makeUnit("defender", { toughness: 5 });
    const events = resolveLaneCombat([attacker], [defender], noopHooks());
    expect(events).toContainEqual({ type: "damage", source: "attacker", target: "defender", amount: 2 });
  });
});

describe("resolveLaneCombat — excess units hit the base once the opposing side is truly empty", () => {
  it("deals base damage when no living opposing unit remains anywhere on that side", () => {
    const A = makeUnit("A");
    let baseDamage = 0;
    const hooks: LaneCombatHooks = {
      dealDamageToBase(side, amount) {
        baseDamage += amount;
      },
      isLaneDeactivated: () => false,
      drainTriggersAndStatics() {},
    };
    const result = resolveLaneCombat([A], [], hooks);
    expect(result).toContainEqual({ type: "excessBaseDamage", source: "A", side: "B", amount: 1 });
    expect(baseDamage).toBe(1);
  });

  it("stops resolving the lane immediately once it's deactivated mid-combat", () => {
    const A = makeUnit("A");
    const A2 = makeUnit("A2");
    let deactivated = false;
    const hooks: LaneCombatHooks = {
      dealDamageToBase() {
        deactivated = true; // base hit to 0 deactivates the lane
      },
      isLaneDeactivated: () => deactivated,
      drainTriggersAndStatics() {},
    };
    const events = resolveLaneCombat([A, A2], [], hooks);
    // Only the first excess unit should get to act before the lane deactivates.
    expect(events.filter((e) => e.type === "excessBaseDamage")).toHaveLength(1);
    expect(events[events.length - 1]).toEqual({ type: "laneDeactivated" });
  });
});
