// Whether an ability is currently ALLOWED to fire/resolve at all — usage limits
// and negation. Checked BEFORE an ability is queued or executed, so it lives
// upstream of both abilityQueue.ts (queueing) and actions.ts (executing).
//
// Nothing in the engine calls these yet: there's no trigger-dispatch loop
// watching for SoT/EtB/Fall/etc. and automatically firing matching abilities —
// see GAME_ENGINE_SPEC.md §10's roadmap for that. These are the pure rules that
// loop will need to consult once it exists, built and tested now rather than
// invented ad hoc later — the same approach actions.ts's computeCurrentTypes
// took ahead of anything that reads it.

import type { CardInstance, MatchState } from "../types/state.js";
import type { Ability, AtomicUsageLimit, UsageLimit } from "../types/abilities.js";

/**
 * Whatever "the current instance" of a limit's scope is right now, so a stale
 * record (from a previous turn/combat) can be told apart from a current one —
 * comparing `scopeId`s IS the reset mechanism, rather than an explicit reset
 * step run somewhere else. `perGame` returns a constant: there's only ever one
 * "instance" of the whole game, so its count simply never resets.
 */
function currentScopeId(limit: AtomicUsageLimit, ctx: UsageContext): number {
  if (limit.kind === "perTurn") return ctx.turnNumber;
  if (limit.kind === "perCombat") return ctx.combatNumber;
  return 0;
}

/** Normalizes any UsageLimit to a flat list of independently-tracked atomic
 *  limits — a plain (non-compound) limit becomes a one-element list, so the
 *  rest of this module never needs to branch on compound-vs-not. */
function atomicLimits(limit: UsageLimit | undefined): AtomicUsageLimit[] {
  if (!limit) return [];
  return limit.kind === "compound" ? limit.limits : [limit];
}

/**
 * Everything the current turn/combat number that a scope check needs —
 * deliberately passed in rather than read off a state object, since
 * `combatNumber` doesn't have a settled home yet (TurnMachineState tracks
 * combat initiation via `attackTokenSpentThisTurn`/`combatInitiatorId`, but has
 * no running combat counter — see spec §9). Whatever eventually wires this up
 * (once TurnMachineState and MatchState are unified) just needs to supply both
 * numbers; this module doesn't need to know where they come from.
 */
export interface UsageContext {
  turnNumber: number;
  combatNumber: number;
}

/**
 * spec §4/§9: usage limits, generalized to ANY ability (not just Activated
 * ones — see UsageLimit's doc comment in abilities.ts for the real triggered-
 * ability example that required this). Tracked per-instance, per-ability-id,
 * on CardInstance.abilityUsage — never on the (static, shared-by-every-copy)
 * Ability/ModeDefinition data — specifically so two copies of the same card, or
 * the same physical card returning to the battlefield later, each track their
 * own independent usage, and so a perGame count survives a zone change the
 * same way counters do (spec §5's zone-change rule).
 *
 * An ability with no usageLimit (or no id — nothing to key the record by) is
 * always available; this is the common case for most abilities. A compound
 * limit ("once per turn, thrice per game") requires EVERY component to still
 * have room — confirmed real cards combine a turn- or combat-scoped cap with a
 * game-scoped one this way.
 */
export function isUsageAvailable(instance: CardInstance, ability: Ability, ctx: UsageContext): boolean {
  if (!ability.id) return true;

  return atomicLimits(ability.usageLimit).every((limit, i) => {
    const record = instance.abilityUsage?.[`${ability.id}:${i}`];
    if (!record) return true;
    const scope = currentScopeId(limit, ctx);
    const count = record.scopeId === scope ? record.count : 0; // stale scope = implicitly reset
    return count < limit.n;
  });
}

/**
 * Call once an ability with a usageLimit actually resolves, to record the use
 * against EVERY component of its limit at once (a single resolution counts
 * against "once per turn" and "thrice per game" simultaneously, not one or the
 * other). A no-op (returns the instance unchanged) for abilities with no
 * usageLimit or no id — nothing to track for those.
 */
export function recordAbilityUsage(instance: CardInstance, ability: Ability, ctx: UsageContext): CardInstance {
  const limits = atomicLimits(ability.usageLimit);
  if (!ability.id || limits.length === 0) return instance;

  const usage = { ...instance.abilityUsage };
  limits.forEach((limit, i) => {
    const key = `${ability.id}:${i}`;
    const scope = currentScopeId(limit, ctx);
    const prior = usage[key];
    const count = prior?.scopeId === scope ? prior.count + 1 : 1; // stale scope = fresh count, not accumulated
    usage[key] = { scopeId: scope, count };
  });

  return { ...instance, abilityUsage: usage };
}

/**
 * spec §4's Negate. Two of its three scopes are per-object, checked against the
 * SOURCE object's own statusEffects (state.ts's `negated` StatusEffect):
 * `allAbilitiesOfObject` silences everything on it; `thisAbilityOnly` needs
 * `ability.id` to match, so a card with several abilities can have exactly one
 * silenced while the rest keep working — this is the property the game designer
 * specifically flagged needing to hold, and it's why Ability.id and this
 * per-ability keying exist at all rather than a coarser per-object-only flag.
 *
 * The third scope, `allCardsMatchingName`, is checked separately against
 * MatchState.activeNameNegations, NOT against statusEffects — see that field's
 * doc comment in state.ts for why it has to live globally instead. `cardName`
 * has to be passed in rather than derived here, because deriving a display name
 * from an instance needs the card database — card loading isn't built yet,
 * same reason actions.ts's DefinitionLookup exists at all. Pass undefined if
 * it's not available yet; that scope just won't match anything until it is.
 */
export function isAbilityNegated(
  state: MatchState,
  sourceInstanceId: string,
  ability: Ability,
  cardName: string | undefined
): boolean {
  const unit = state.units[sourceInstanceId];
  const objectNegated =
    !!unit &&
    unit.statusEffects.some(
      (s) =>
        s.kind === "negated" &&
        (s.scope === "allAbilitiesOfObject" || (s.scope === "thisAbilityOnly" && s.abilityId === ability.id))
    );
  if (objectNegated) return true;

  if (!cardName) return false;
  return state.activeNameNegations.some((n) => n.cardName === cardName);
}
