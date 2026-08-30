# Card Game Engine — Project Scaffold

See `GAME_ENGINE_SPEC.md` (delivered alongside this project) for the full design rationale. This is the code half of that document.

## Structure

```
packages/
  engine/          — headless rules engine. Zero UI/network dependencies by design:
                     it's a pure function of (state, command) -> (state, events), so
                     it can run client-side for local play now and server-side,
                     unchanged, once multiplayer is built.
    src/
      types/
        cards.ts       — CardDefinition, ModeDefinition, TokenDefinition,
                          LocationDefinition, FusedDefinition, Keyword, Counter,
                          Duration, InfluencePips
        abilities.ts   — Ability, TriggerSpec, TargetSpec, Action (incl.
                          ChangeCardType, massIncrement), QueuedAbility
        state.ts       — MatchState, PlayerState, LaneState, CardInstance,
                          BattlefieldUnit, Phase (StartPhase/MainPhase/
                          Repositioning/TrapPlacement/TrapResolution/Damage/EndPhase)
      combat/
        combatResolution.ts  — the damage-phase algorithm (active/passive queue +
                                live-roster loop-around model), fully implemented
                                and tested
      phase/
        priorityWindow.ts    — the generic alternating-priority-window primitive shared
                                by Main Phase, Repositioning, and Trap Placement
        turnMachine.ts       — the full phase state machine wiring everything together,
                                including StartPhase/EndPhase's simultaneous-decision
                                pattern (distinct from the alternating one above)
      resolution/
        targeting.ts     — resolves TargetSpec against real MatchState: lane scope
                           (incl. wraparound adjacency), allegiance, position,
                           zone-based (hand/graveyard/deck); also the re-validation
                           check used at resolution time (§7)
        actions.ts       — executes a representative subset of Action primitives
                           (dealDamage, heal, addCounter, removeCounter, buffStat,
                           freeze, draw, destroy, sacrifice) against MatchState;
                           computeCurrentStats (base + counters + status - damage,
                           derived rather than stored) and processStateBasedDeaths
        abilityQueue.ts  — queueAbility/resolveQueuedAbility implementing §7's
                           target-snapshot rule: lock candidates in at queue time,
                           re-validate (not re-select) at resolution time
        stateHelpers.ts  — small immutable-update helpers over MatchState's nested
                           Records, used throughout the above
    test/
      combatResolution.test.ts  — replicates the exact worked combat examples from
                                  design discussion, including the death-mid-combat/
                                  token-spawn case, both freeze variants, the
                                  active/passive queue distribution fix, and first
                                  strike composing with an on-damage freeze effect
      priorityWindow.test.ts   — the attack-token-holder-cannot-pass rule
      turnMachine.test.ts      — a full turn cycle end to end: StartPhase influence
                                  choice, forced combat, repositioning charges, trap
                                  LIFO order (global, not per-lane), multi-lane
                                  damage, priority handoff, EndPhase discard, and
                                  rolling into the next turn's StartPhase with the
                                  attack token alternated
      targeting.test.ts        — lane scope (incl. wraparound), allegiance, position,
                                  zone-based targeting, and re-validation semantics
      actions.test.ts          — each implemented action, plus computeCurrentStats
                                  and processStateBasedDeaths
      abilityQueue.test.ts     — the actual §7 failure modes this design exists to
                                  prevent: a locked target dying before resolution,
                                  a new object NOT retroactively qualifying, and a
                                  trap-stack-shaped scenario with two traps sharing
                                  a target that dies between them

  client/  (not yet started)
  server/  (not yet started)
```

## Running things

```
npm install                                          # from repo root
npm run test --workspace=packages/engine             # run the engine's test suite
npx tsc -p packages/engine/tsconfig.json --noEmit     # typecheck only
```

## What's implemented vs. what's next

**Implemented and tested (43 tests passing, clean typecheck including test files):**

- Full card/token/location/fusion/ability type system, matching the spec exactly —
  including multi-typed objects (`types: CardType[]`, not a single `type`), tokens
  that can be any card type and exist off the battlefield, and Fuse's type-level
  shape (`FusedDefinition`)
- The damage-phase combat algorithm, including the active/passive queue correction
  and a general `canDealDamage()` predicate so First Strike composes correctly with
  arbitrary on-damage effects without needing to know about them specifically
- The generic priority-window primitive (turn cannot end while the attack token is
  unspent)
- The full turn/phase state machine: `StartPhase -> MainPhase -> Repositioning ->
TrapPlacement -> TrapResolution -> Damage -> MainPhase -> ... -> EndPhase ->
(next turn's) StartPhase`
- **The ability-resolution engine's core machinery**: target resolution against real
  board state, a representative subset of Action primitives, and — the piece with
  the most correctness risk — the §7 target-snapshot rule (lock at queue time,
  re-validate at resolution time), proven against the exact failure modes it was
  designed to prevent rather than just reasoned about abstractly

**Known integration gap, not yet addressed:** `turnMachine.ts` (phase/control flow)
and the new `resolution/` modules (game data/effects) currently operate on two
_separate_ state shapes (`TurnMachineState` vs. `MatchState`) — deliberately, so
each could be built and tested in isolation the same way `combatResolution.ts` was
before `turnMachine.ts` existed to feed it real data. Unifying them so
`turnMachine.ts`'s hooks (`isLegalPlay`, `resolveTrapEffect`, etc.) actually call
into this resolution engine is real, not-yet-done integration work — the natural
next step after this one.

**Not yet built** (next slices, roughly in order):

1. Unify `TurnMachineState`/`MatchState` and wire `turnMachine.ts`'s hooks to the
   resolution engine built this slice (see above)
2. The decision-checkpoint mechanism (spec §7) — player-chosen targets, chooseOne/
   chooseAnyNumber, simultaneous-trigger ordering. `queueAbility` already detects
   when it's needed (`needsDecision`) and refuses to guess; this is what actually
   handles it
3. The rest of the `Action` primitive list, following the same pattern as the
   subset already implemented
4. Card loading from data (turning the card database into `CardDefinition[]`,
   which also replaces the tests' `TestStatsRegistry` stand-in for `DefinitionLookup`)
5. A local play loop and minimal UI
