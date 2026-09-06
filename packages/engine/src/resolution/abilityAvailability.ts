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
import type { Ability } from "../types/abilities.js";

/**
 * spec §4/§9: "once per turn" / "once per game" usage limits, generalized to
 * ANY ability (not just Activated ones — see UsageLimit's doc comment in
 * abilities.ts for the real triggered-ability example that required this).
 * Tracked per-instance, per-ability-id, on CardInstance.abilityUsage — never on
 * the (static, shared-by-every-copy) Ability/ModeDefinition data — specifically
 * so two copies of the same card, or the same physical card returning to the
 * battlefield later, each track their own independent usage, and so a
 * oncePerGame count survives a zone change the same way counters do (spec §5's
 * zone-change rule).
 *
 * An ability with no usageLimit (or no id — nothing to key the record by) is
 * always available; this is the common case for most abilities.
 *
 * `compound` limits are NOT evaluated here — see UsageLimit's doc comment /
 * spec §9: what "compound" actually composes is still undefined. Treated as
 * always-available (permissive) rather than silently guessing a wrong
 * restrictive interpretation; flag this the moment a real card needs it.
 */
export function isUsageAvailable(instance: CardInstance, ability: Ability, currentTurnNumber: number): boolean {
  const limit = ability.usageLimit;
  if (!limit || limit === "none" || !ability.id) return true;

  const record = instance.abilityUsage?.[ability.id];
  if (!record) return true;

  if (limit === "oncePerGame") return record.count < 1;
  if (limit === "oncePerTurn") return record.lastTurnNumber !== currentTurnNumber || record.count < 1;
  return true; // compound — see doc comment above
}

/**
 * Call once an ability with a usageLimit actually resolves, to record the use.
 * A no-op (returns the instance unchanged) for abilities with no usageLimit or
 * no id — nothing to track for those.
 */
export function recordAbilityUsage(instance: CardInstance, ability: Ability, currentTurnNumber: number): CardInstance {
  const limit = ability.usageLimit;
  if (!limit || limit === "none" || !ability.id) return instance;

  const prior = instance.abilityUsage?.[ability.id];
  const carriesOverWithinTurn = limit === "oncePerTurn" && prior?.lastTurnNumber === currentTurnNumber;
  const nextCount = limit === "oncePerGame" || carriesOverWithinTurn ? (prior?.count ?? 0) + 1 : 1;

  return {
    ...instance,
    abilityUsage: { ...instance.abilityUsage, [ability.id]: { count: nextCount, lastTurnNumber: currentTurnNumber } },
  };
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
