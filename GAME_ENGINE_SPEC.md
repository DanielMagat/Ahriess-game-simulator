# Card Game Engine — Design Specification (v0.1)

Status: foundational design confirmed; ready for implementation. This document consolidates every architectural and rules decision made during design discussion, so it can stand alone as a reference during implementation without needing the original conversation.

---

## 1\. Overview & Goals

A digital simulator for a custom lane-based card game, architected from the start so the MVP is not throwaway work:

1. **MVP**: headless rules engine \+ local single-machine play (vs. AI or hotseat), built as if it were already running remotely.  
2. **Phase 2**: deck builder, accounts, deck persistence.  
3. **Phase 3**: move the engine server-side, add matchmaking, WebSocket sync, reconnect handling.  
4. **Phase 4** (explicitly deferred, maybe indefinitely): card acquisition limits, monetization.

The guiding principle throughout: **one shared, headless rules engine**, used locally now and hosted server-side later, unchanged. Multiplayer becomes a deployment change, not a rewrite.

## 2\. Architecture

**Platform**: browser-based web app. No native-app requirement; Electron/Tauri wrapping remains an option later at low marginal cost.

**Subsystems**:

1. Card Data Layer — what cards exist and what they do (this document, §4)  
2. Rules Engine — headless simulator: state, phases, resolution (§5–8)  
3. Persistence Layer — accounts, decks, match history (future phase)  
4. Networking Layer — WebSockets, server-authoritative once online play exists (future phase)  
5. Client/Presentation Layer — renders whatever state/events the engine produces

**Tech stack**: TypeScript everywhere (engine, and later client/server), so card definitions and engine logic are shared verbatim rather than duplicated and drifting. React for the client when built. Node \+ Postgres \+ WebSockets for the eventual server. The engine package itself has zero UI or network dependencies — it is a pure function of (state, command) → (state, events).

## 3\. Game Rules Foundation

### Resources

- **Energy**: spent to play Unit/Structure/Invocation cards and activate abilities. Resets to max each turn; max increases by 1 per turn (Hearthstone-style mana crystal). A separate "temporary energy" variant exists (gained mid-turn, does not persist as max).  
- **Influence**: one pool per color (E, S, I, B). Gained \+1/turn in a player-chosen color. **Not consumed** by normal card-cost requirements — it's a threshold you must meet, not a payment. **Is** permanently consumed by Trap costs, and can be deliberately spent/sacrificed by specific card effects. Wildcard influence pips (`X`) exist on some Trap costs, payable with any color.  
- Every Unit/Structure/Invocation has **both** an energy cost (a number) and an influence requirement (color pips) — the two are independently set by the designer and need not correlate. Traps have an influence cost only, no energy cost.

### Turn structure

1. Start of turn: one player gets priority \+ the attack token (alternates who starts).  
2. Both players draw 3 cards.  
3. Both gain \+1 max energy, refill current energy to max.  
4. Start-of-turn triggers fire.  
5. Each player gains \+1 influence in a color of their choice.  
6. **Turn Priority** loop (see §6) — the main phase.  
7. End of turn: discard down to 2 cards in hand; end-of-turn triggers fire.

### Board layout

- 4 lanes. Each lane has: a Location card (assigned pre-game via a draft procedure, not part of either deck), a base health total per player (starts at 10), and each player's **attack sequence** — an ordered list of that player's units in the lane.  
- New units are always appended to the **end** of their side's attack sequence in that lane, regardless of how they got there (played, summoned, or moved in from another lane).  
- A lane is **deactivated** when a base reaches 0; no further combat occurs there.
- **Adjacency**: the four lanes wrap around — lane 1 and lane 4 (leftmost and rightmost) are adjacent to each other, not just to their immediate neighbor. Relevant to any card that scopes an effect to "adjacent lanes."

### Repositioning charges

- A resource separate from Energy/Influence, governing how many times units can move lanes during the Repositioning step of combat (§6).
- At the start of Repositioning (i.e., the moment combat is initiated), **both players'** charge pools are set to the current turn number — turn 3 grants 3 charges each, turn 10 grants 10, etc.
- Moving a unit to another lane costs 1 charge by default. `Agile n` (§4 Keywords) lets a unit's first `n` moves that repositioning phase skip the charge cost entirely.
- Charges are per-player, not per-unit — a player spends from one shared pool no matter which of their units they're moving.

### Deckbuilding

- Decks are 40 cards, maximum 3 copies of any single card. Both numbers are provisional — expect them to move once playtesting has real data.
- No other deckbuilding restrictions currently (no color/influence identity limits, no separate sideboard, etc.) — subject to change.
- Locations are **not** part of either player's deck. All Locations in the game live in one shared pool that the pre-game draft procedure draws from to assign one to each of the 4 lanes.

### The attack token

- Only one exists per turn, held by one player. Spending it means initiating combat.  
- **The holder cannot pass priority until they've spent it.** This guarantees at least one combat every turn — there's no path to end-of-turn via double-pass while the token is unspent, since the holder always has "initiate combat" as a fallback legal action.  
- Once spent, the token holder can pass normally like their opponent always could.  
- Not regained same-turn by default (a specific Location card is a rare exception that grants the opponent one back).

## 4\. Card Data Model

### CardDefinition — shared identity of a physical card

CardDefinition {

  id: string

  setCode, collectorInfo, imageURL          // presentation only

  modeA: ModeDefinition                      // always Unit | Structure | Invocation

  modeB: ModeDefinition                      // Unit | Structure | Invocation | Trap

}

Confirmed from the card pool: mode A (the "cheap" mode) is **never** a Trap. Mode B can be any of the four types, including a second Unit/Structure/Invocation at a different (usually higher) cost — "trap or higher-cost effect" in the source rules text really does mean either. Each mode has its own name — display name lives on the mode, not the card (front/back are effectively different cards sharing one physical object). Mode is tracked as a persistent property of an object even after it leaves the battlefield, since recursion effects care which mode it re-enters as.

### ModeDefinition

ModeDefinition {

  name: string

  type: "Unit" | "Structure" | "Invocation" | "Trap"

  cost: {

    energy?: number                          // absent for Trap

    influence: { E: number, S: number, I: number, B: number, wildcard: number }

  }

  basePower?, baseToughness?                 // Unit only

  keywords: Keyword\[\]

  abilities: Ability\[\]

}

### TokenDefinition — game-generated objects, not deck cards

TokenDefinition {

  name: string

  type: "Unit" | "Structure" | "Invocation" | "Trap"

  modeTag: "A" | "B"                         // see below

  cost: {

    energy?: number                          // absent for Trap, same rules as ModeDefinition

    influence: { E: number, S: number, I: number, B: number, wildcard: number }

  }

  basePower?, baseToughness?                 // Unit only

  abilities?: Ability\[\]                      // usually empty — most tokens are vanilla

}

Tokens are **not deck-eligible** — you can't put one in a deck pre-game — but unlike MTG, a token is not confined to the battlefield: effects can return, discard, or otherwise move a token to hand, graveyard, etc., the same as any other object. Because a token can end up in hand and be played from there, it needs a real cost the same way a card's mode does, and can be of any of the four types, including Invocation or Trap. `modeTag` doesn't mean a token has two switchable modes the way a card does — it's a fixed "A" or "B" label that exists purely so effects that ask "is this a first-mode object" (or similar mode-relative text) can evaluate correctly against a token. A small registry of recurring templates (1/1 Squirrel, 5/5 Beast, etc.) avoids redefining the same token inline across many card effects.

### LocationDefinition

Reuses the same `Ability[]` machinery as cards, but has no cost block and no modes — a single definition, assigned pre-game via the draft procedure. Locations skew heavily toward one-of-a-kind mechanics (form-switching, fusion, replicating abilities) and are expected to lean disproportionately on the custom-hook escape hatch described below, rather than the composable primitive list.

### Ability, Trigger, Target, Action

Ability {

  trigger: TriggerSpec

  condition?: ConditionExpr

  target?: TargetSpec

  action: Action\[\] | { hook: string }        // composable primitives, OR named escape hatch

}

`TriggerSpec` — confirmed trigger points: `EtB`, `Fall`, `SoT` (incl. specific-turn-number variants), `EoT`, priority-window "you may" effects, `StartOfCombat`, during Repositioning, during Trap Placement, end of Trap Placement (*before* the stack resolves — a distinct hook from the resolution itself), Trap resolves, `StartOfDamage`, a unit dealing/taking combat damage, `EndOfCombat`, `LaneDeactivated`, `Activated{cost, usageLimit}` (`usageLimit`: none / once-per-turn / once-per-game / compound), plus a `Custom` escape variant for anything that doesn't fit cleanly.

`TargetSpec` — **no card in the pool uses the word "target."** Selection is always descriptive/positional: lane scope (`this lane` / adjacent / other lanes / all lanes — `this lane` dominates overwhelmingly), allegiance (allied/enemy/each player's), sequence position (first/last-in-sequence — "first" dominates), quantity (single / each matching / any number chosen by the player), zone (hand/graveyard/deck-top-N), rarely random. See §7 for how selection interacts with queued (non-immediate) resolution.

`Action` primitives, by category:

| Category | Primitives |
| :---- | :---- |
| Damage/healing | `dealDamage`, `heal` |
| Card/zone movement | `draw`, `discard`, `exile`, `sacrifice`, `destroy`, `returnToHand`, `search`, `moveUnit` (lane→lane, appends to end of new sequence), generic `moveZone` |
| Counters/stats | `addCounter` / `removeCounter`, `buffStat` (permanent or `until X`), `massIncrement` (see Counters below) |
| Board control | `freeze`, `negate` (see Keywords — one canonical mechanic, previously mis-split into three names) |
| Cost/economy | `modifyCost` (often conditional, e.g. "1 less per Trap played"), `gainEnergy` (temporary vs. permanent-max), `gainInfluence`, `spendInfluence` |
| Meta-structural | `copy`, `fuse`, `switchForm`, `createToken`, `transform`, `changeCardType` (a handful of cards change a target's card type; bidirectional — `from`/`to` are each a list of `CardType`) |
| Modal/choice | `chooseOne`, `chooseAnyNumber`, `lookAtTopN` \+ rearrange — these are **resolution-time decision points**, not upfront targeting (§7) |

**Duration** (for temporary effects): `untilNextCombat`, `untilEoT`, `untilEndOfCombat`, `untilNextSoT`, `untilPhaseIn`, `untilCondition(expr)`, `permanent`.

### Keywords — sugar over the Ability system, not a separate mechanism

Keyword \=

  | { kind: "Poisonous", n: number }        // when this deals damage to a unit, place n poison counters on it — see Counters below for what poison does

  | { kind: "Agile", n: number }            // first n moves/repositioning phase don't cost a charge (§3, Repositioning charges)

  | { kind: "Immobile" }                    // cannot move during repositioning

  | { kind: "Wither" }                      // damage dealt to units also permanently reduces their power

  | { kind: "FirstStrike" }                 // see §8 — sequences a single matchup, not a separate phase

  | { kind: "Deathtouch" }                  // any damage destroys the target

  | { kind: "Lifelink" }                    // when this deals damage, heal your base in this lane by that much

  | { kind: "Ephemeral" }                   // sacrifice this permanent at end of turn (any Unit/Structure mode may carry this — not token-exclusive)

  | { kind: "MoraleBreaker", n: number }    // "when this kills an enemy unit in combat, deal n damage to the enemy base" — formerly "KillTrigger" internally; this is the confirmed public name

**Deferred, not implemented**: an "Unlock" mechanic (pay a permanent's other mode's cost to grant it that mode's effects additionally) — too complex for its actual usage rate; revisit only if it comes back into active card design.

**Negate** is the one canonical name for ability/effect suppression, parameterized by scope: `Negate(scope: thisAbilityOnly | allAbilitiesOfObject | allCardsMatchingName, duration)`. ("SuppressEffects" and "disableThisAbility" from earlier drafts were the same mechanic named inconsistently, not three mechanics.)

### Counters

Counter { name: string, count: number, semantics: "builtin" | "generic", polarity: "beneficial" | "detrimental" }

**Built-in** (engine-understood behavior): `+1/+1` / `-1/-1` (permanent stat mod), `shield` (fully prevents the next damage-or-destroy instance, then depletes by 1), `plating` (reduces incoming damage by its current count, then depletes by exactly 1 regardless of how much it blocked — a meaningfully different rule from shield), `poison` (placed by the `Poisonous` keyword; at end of turn, a unit takes damage equal to its poison count — the counters do **not** deplete afterward; a unit keeps ticking for its full poison count every end of turn until something else removes the counters).

**Polarity**: every counter, built-in or generic, is tagged `beneficial` or `detrimental` from its controller's point of view — `+1/+1`, `shield`, `plating` are beneficial; `-1/-1`, `poison` are detrimental. This exists specifically to support `massIncrement` (§4 Action table): mass-incrementing a card increases all of *its* beneficial counters by 1 if the card is allied to the effect's controller, or all of its detrimental counters by 1 if the card is enemy to the effect's controller — so one effect definition covers "mass increment an allied unit/structure here," "mass increment all enemy cards here," and "mass increment all cards everywhere" alike, without the effect needing to know which specific counters exist on the target. This is also why polarity is modeled as a property of the counter rather than hardcoded into `massIncrement` itself as a fixed list of counter names — new counters (including the reworked bespoke ones below) only need a polarity tag to slot into `massIncrement` correctly, not a code change to the action itself.

**Generic** (name \+ number only; all meaning lives in that card's own hook): the bespoke counters observed in the current card pool (mark, reaction, thirst, time, finality, and one card-specific "charge" counter) are being reworked by the designer and are **explicitly not to be implemented yet** — don't build special-case logic for any of them until the rework lands. Once it does, expect there to be a small number of these, each still needing a polarity tag for `massIncrement` purposes, with the rest of their meaning living in that card's own hook rather than generalized engine behavior.

---

## 5\. Match State

MatchState {

  turnNumber, activePlayerId, attackTokenHolderId, attackTokenSpentThisTurn: bool

  phase: TurnPriority | Repositioning | TrapPlacement | TrapResolution | Damage

  priorityPlayerId, consecutivePasses

  repositioningCharges: { [playerId]: number }  // both set to turnNumber at the start of Repositioning (§3)

  rngState                                   // seeded, logged — deterministic replay

  eventLog: Event\[\]                          // append-only; feeds replay/spectator views later

  players: \[PlayerState, PlayerState\]

  lanes: \[LaneState, LaneState, LaneState, LaneState\]

  globalTrapStack: QueuedTrap\[\]               // every set-but-unresolved trap on the board, one shared LIFO stack (see below)

  triggerQueue: QueuedAbility\[\]               // pending simultaneous triggers awaiting an ordering decision

}

PlayerState {

  energy: { current, max }

  influence: { E, S, I, B }

  zones: { deck: CardId\[\], hand: CardId\[\], graveyard: CardId\[\] }

}

LaneState {

  locationCard: LocationDefinitionId

  baseHealth: \[number, number\]                // per player

  attackSequence: \[BattlefieldUnitId\[\], BattlefieldUnitId\[\]\]   // per player, ordered

  structures: \[BattlefieldStructureId\[\], BattlefieldStructureId\[\]\]

}

BattlefieldUnit {

  id, controllerId, laneId, positionInSequence

  source: { kind: "card", cardDefId, mode } | { kind: "token", tokenDefId }

  currentPower, currentToughness

  counters: Counter\[\]

  statusEffects: StatusEffect\[\]                // frozen, phasedOut, temporary keyword grants, etc.

}

### Zone changes

Unlike MTG's convention of stripping nearly everything when an object changes zones, this game only resets **damage** on a zone change (battlefield → graveyard, hand → battlefield, etc.) — a card always enters a new zone undamaged. Its **counters persist across the change** and are never automatically stripped; they carry over with the object wherever it goes, including back onto the battlefield later if something returns it.

**Traps are global, not per-lane.** A trap is *set* to a specific lane — most of its effects are local to that lane — but all traps on the board resolve from one shared, board-wide LIFO stack, not four independent per-lane stacks. Concretely: if P1 sets a trap to lane 1, then P2 sets a trap to lane 4, P2's trap (set last) resolves first, even though it's a different lane — trap placement order across the whole board determines resolution order, lane assignment doesn't create separate queues.

## 6\. Phase State Machine

A turn is **one continuous priority loop**, not separate pre/post-combat phases — combat is an action available within it, and play resumes in the same loop afterward until both players pass consecutively.

TURN\_PRIORITY:

  legal actions: play card, activate ability,

                 initiate combat (if holds token & unspent),

                 pass (if doesn't hold token, OR already spent it)

  → initiate combat → COMBAT\_REPOSITIONING → COMBAT\_TRAP\_PLACEMENT → COMBAT\_TRAP\_RESOLUTION

    → COMBAT\_DAMAGE → back to TURN\_PRIORITY, priority to non-initiator, token marked spent

  → double pass (only reachable once token is spent) → END\_OF\_TURN → next SoT

`COMBAT_REPOSITIONING` and `COMBAT_TRAP_PLACEMENT` are structurally identical to `TURN_PRIORITY`: alternating action-or-pass, starting with whoever initiated combat, until both pass consecutively — just with a different legal-action set (spend a charge to move a unit; set a trap face down). This should be **one generic "alternating priority window" procedure**, parameterized by starting player and legal-action set, implemented once and reused three times rather than three separate implementations.

## 7\. Resolution & Targeting Semantics

There is no MTG-style stack of instants, but there **are** two places where an ability sits in a queue rather than resolving the instant it's declared: the **trap stack** (set during placement, resolves LIFO afterward) and the **simultaneous-trigger queue**. Anything can happen to the board between an ability being queued and it actually resolving — including a target dying, or a new object appearing that wasn't there when the ability was queued and should not retroactively qualify.

The fix, adapted from how MTG's stack handles the same problem: **any ability that enters a queue snapshots its selection at the moment it's queued, not at the moment it resolves.**

- A player choice ("choose an enemy unit") is made **when the ability is queued**.  
- An automatic scope ("each enemy unit here") is evaluated **once, at queue time**, into a fixed list of specific object references.  
- At resolution, the engine re-validates each locked reference against the *original* selection criteria — existence, location, type/allegiance. Anything that no longer qualifies is dropped silently; the effect applies to whatever survives. Nothing gets re-selected to fill the gap.

This does **not** apply to ordinary Turn Priority card resolution — nothing can interleave between an ability being announced and it resolving there, so there's nothing to snapshot against; selection and execution are the same instant.

QueuedAbility {

  sourceAbilityId, controllerId

  lockedTargets: ObjectRef\[\]                  // specific objects, chosen/evaluated at queue-time

  originalSelectionCriteria                   // used only for the re-legality check, never re-selection

}

**Generalized decision-checkpoint mechanism**: simultaneous-trigger ordering, and resolution-time player choices ("choose one," "choose any number," "look at 3, keep 1") are the same underlying mechanism — any point in resolution requiring player input pauses the engine, emits a decision request, and resumes only once the player responds. One codepath, not a special case per situation.

## 8\. Combat Damage Algorithm

Lanes resolve fully, one at a time, left to right; deactivated lanes are skipped. Within a lane, each side is tracked with **three structures**, not one FIFO queue as originally drafted here — the single-queue version (below, for the record) turned out to have a real bug: it let excess attackers repeatedly pile onto the same still-living defender instead of spreading out. The corrected model:

- **roster**: the persistent, order-preserving live-unit list for that side (mirrors the real attack sequence). Append-only — new arrivals (death-triggered summons, etc.) are pushed on; nothing is ever removed from it, liveness is just checked live via toughness. This is the source of truth for "who's still alive."
- **active queue**: a transient FIFO of units still owed their *own* initiating turn this combat. Seeded from the roster when combat begins; new arrivals get pushed here too so they get a turn. Pairs off against the opponent's active queue whenever both sides have one. **Drives whether combat continues at all** — once both active queues are empty, the lane's combat is over, regardless of what's sitting in a passive queue.
- **passive queue**: a transient FIFO, built lazily — only the moment one side's active queue is empty but the other side still has a unit needing an opponent. Built from whichever of that side's roster members are *currently* alive, then consumed by popping — so several excess attackers in a row each get a *different* survivor instead of all finding the same one. Once it drains, it's rebuilt fresh from whoever's alive at that later point the next time it's needed — that's what produces a second full "lap" when the mismatch is big enough.

resolveLaneCombat(lane):

  rosterA, rosterB \= copy(lane.sideA.attackSequence), copy(lane.sideB.attackSequence)

  activeA, activeB \= copy(rosterA), copy(rosterB)     \# separate copies — active queues are consumed, rosters aren't

  passiveA, passiveB \= \[\], \[\]                          \# built lazily, see popFromPassive below

  while activeA not empty or activeB not empty:

    dropDeadFront(activeA); dropDeadFront(activeB)     \# died before its turn: removed silently, no event

    if activeA not empty and activeB not empty:

      u \= activeA.popFront(); v \= activeB.popFront()

      resolveMutualEvent(u, v)

    elif activeA not empty:

      resolveExcessEvent(activeA.popFront(), opposingSide=B)

    else:

      resolveExcessEvent(activeB.popFront(), opposingSide=A)

    drainTriggersAndStatics()                          \# Fall/EtB fire, static abilities re-evaluate

    if lane.isDeactivated: return                        \# stop this lane, move to the next

resolveMutualEvent(u, v):

  if u.frozen and v.frozen:

    return                                              \# no fight event at all

  if hasFirstStrike(u) xor hasFirstStrike(v):

    striker, other \= (u, v) if hasFirstStrike(u) else (v, u)

    if not striker.frozen: dealDamage(striker \-\> other)

    drainTriggersAndStatics()

    if other.alive and not other.frozen: dealDamage(other \-\> striker)

  else:

    if not u.frozen: dealDamage(u \-\> v)

    if not v.frozen: dealDamage(v \-\> u)

popFromPassive(side):                                   \# rebuilds from the live roster only when actually empty

  dropDeadFront(passive\[side\])

  if passive\[side\] is empty:

    passive\[side\] \= roster\[side\].filter(isAlive)        \# a fresh snapshot of who's alive right now

  return passive\[side\].popFront()                       \# undefined if that side has no living units left at all

resolveExcessEvent(u, opposingSide):

  if u.frozen:

    return                                              \# frozen units never initiate — no search, no base damage

  opponent \= popFromPassive(opposingSide)

  if opponent exists:

    resolveMutualEvent(u, opponent)                      \# opponent may already have had its own turn — that's fine

  else:

    dealDamageToBase(u, opposingSide.base)

**Shield/plating** (§4 Counters) are checked inside `dealDamage`, before toughness is touched: a shield present fully absorbs the hit (no damage event at all) and depletes by 1; otherwise, plating present reduces the raw amount (floored at 0) and depletes by exactly 1 regardless of how much it absorbed. Both apply to combat damage exactly the same way they apply to a `dealDamage` action outside of combat.

**Freeze**, fully reproduced by one rule: a frozen unit never deals damage and never initiates a search-or-base-hit, but remains fully valid as something another unit's initiation can find and damage.

**Worked traces** (all confirmed against the engine's own tests):
- *3 attackers vs. 2 defenders* (A,B,C vs. 1,2): A–1, B–2, then C loops back to fight 1 again (1 already had its own turn, but it's still alive, so the freshly-built passive queue for the defending side starts with it).
- *4 attackers vs. 2 defenders* (A,B,C,D vs. 1,2): A–1, B–2, then the two excess attackers get **different** defenders — C–1, D–2 — rather than both piling onto 1. (This is the case the original single-queue draft got wrong.)
- *5 attackers vs. 2 defenders* (A,B,C,D,E vs. 1,2): A–1, B–2, C–1, D–2, and then E starts a **second full lap**, landing back on 1 — the passive queue drained after C and D, so it's rebuilt fresh from the living roster and starts again from the front.
- *Designer's original example* (sideA \= \[A,B,C\], sideB \= \[1,2\], unit 2 dies and spawns tokens 3 and 4, appended to both B's roster and active queue): A–1, B–2 (2 dies, 3 and 4 join), C–3 (not a "search" — C's own turn reliably meets the next arrival), then 4 is excess with nothing left in B's active queue — it loops around to hit A (the passive queue for side A is freshly built from \[A,B,C\], all still alive, so it starts at the front).

**Dead unit mid-queue**: if a unit is removed from the lane (destroyed, moved, etc.) while still sitting in either an active or passive queue, it's simply dropped with no event when its turn would have come up — combat proceeds with whatever remains.

<details>
<summary>Original single-queue draft (superseded — kept for context on what changed and why)</summary>

The first draft of this algorithm used one FIFO queue per side, with `resolveExcessEvent` doing a fresh "first living unit" lookup against the opposing side every time:

    resolveExcessEvent(u, opposingSide):
      if u.frozen: return
      opponent = firstLivingUnit(opposingSide)  # live query against current state, not a snapshot
      if opponent exists: resolveMutualEvent(u, opponent)
      else: dealDamageToBase(u, opposingSide.base)

The intent behind "live query, not a snapshot" was to let excess attackers find whichever defender is currently alive. In practice, since nothing ever advanced past "the first one," multiple excess attackers in the same lane all piled onto that same defender rather than spreading out — confirmed as a bug, not the intended behavior. The passive-queue model above fixes it while keeping everything else (the worked trace's core shape, freeze's behavior, the "not a search" framing for a same-turn pairing) identical.

</details>

---

## 9\. Open Items / Deferred

- **Shield vs. plating precedence**: when a unit has both a shield counter and a plating counter, the engine currently checks shield first (a full-block hit consumes only the shield; plating is untouched that hit) — this wasn't specified anywhere and was a judgment call made during implementation. Flagging for confirmation; easy to flip if wrong.
- **Unlock mechanic** deferred entirely — not in the active vocabulary, revisit only on demand.  
- **"Faceless Giga Armor"** has no colors/manacost/cmc at all in the source data — still unconfirmed whether this is an intentionally free/fusion-only card or missing data. Doesn't block engine work since the engine handles both interpretations identically (a mode with a zero/absent cost); worth a final check against the source before it's imported for real.  
- Two straight-vs-curly-apostrophe mismatches in the source XML (Archangel's Brilliance/Sekka's Light, Dajani's Dridemate/Power Word Shield) are handled by name normalization at import time; fixing the source file directly would still be worthwhile at some point.

## 10\. Roadmap Recap

1. **Done**: engine scaffolding — types, phase machine, combat resolution (§5–8, implemented and tested against the worked traces above).  
2. **In progress** — ability/effect resolution system: `dealDamage`, `heal`, `freeze`, `buffStat`, `addCounter`/`removeCounter`, `destroy`/`sacrifice`, and `draw` are implemented (including shield/plating mitigation on both combat and non-combat damage); the rest of the `Action` primitive list (§4 table) is still explicit-but-unimplemented. The decision-checkpoint mechanism itself (§7) — pausing resolution for a player choice — is not yet built, though the trap-resolution pipeline is now structured so that when it *is* built, a trap needing a decision correctly blocks progress into Damage rather than being skipped or run out of order. Card loading from data, the local play loop, and a minimal UI are still ahead.  
3. Deck builder, accounts, persistence.  
4. Server-authoritative multiplayer — same engine, hosted remotely, WebSocket transport.  
5. Monetization/acquisition limits, if ever.

**Tooling** (added alongside the above, not blocking it): ESLint + Prettier + a CI workflow now run on every change — see the Decision Log below for why.

## 11\. Decision Log

This section exists because this spec previously went stale relative to real conversations — several rules got clarified verbally in a session and never made it back into this document, which then read as authoritative when it wasn't current. Going forward, anything decided mid-implementation that isn't already covered by a prose section above should get a dated entry here, so the next handoff (Claude instance or otherwise) can tell "confirmed" apart from "someone's best guess" without having to ask.

**2026-08-29** — Batch of clarifications confirmed after a code review surfaced several rules present in the implementation but missing or contradicted here (see below for what each of those was):
- Excess-combat distribution: confirmed intentional — attackers loop around and can repeatedly re-fight, but must distribute across all currently-living defenders before looping back, not pile onto the first one. §8 rewritten to match; original single-queue draft kept inline for context.
- Trap stack is global (board-wide LIFO), not per lane. §5 updated.
- Poisonous reworked to place poison counters (damage at end of turn); counters do not deplete. §4 updated.
- Repositioning charges are a real, core resource (charges = current turn number, 1 charge per move by default) — not something to infer from Agile alone. §3 updated.
- Tokens can occupy zones other than the battlefield and be played from hand as any card type, unlike MTG; hence they need real costs and a `modeTag`. §4 updated.
- Lane adjacency wraps around (lane 1 ↔ lane 4). §3 updated.
- Deckbuilding: 40-card decks, max 3 copies, Locations excluded from the deck and drawn from a shared pool instead. New §3 subsection.
- `changeCardType` and `massIncrement` actions added to the primitive list, with counter polarity (`beneficial`/`detrimental`) added to the Counter type to support the latter. §4 updated. The bespoke/generic counters in the current card pool (mark, reaction, thirst, time, finality, "charge") are being reworked by the designer and are explicitly **not** to be implemented until that lands.
- `KillTrigger` renamed to its confirmed public name, `MoraleBreaker`. §4 updated, §9 item resolved.
- Zone changes reset damage but not counters (counters persist across zone changes, unlike MTG). New §5 subsection.
- Shield/plating counters, previously registered in the type system but never actually intercepting damage anywhere, now do (both in combat and in the general `dealDamage`/`destroy` actions) — see §9 for the one remaining open call (precedence when a unit has both).
- Trap-resolution phase ordering fixed: the engine now enters the `TrapResolution` phase *before* resolving traps, not after (previously the event log briefly misattributed trap-resolution events to `TrapPlacement`).
- Trap resolution restructured to halt correctly (stay in `TrapResolution`, never advance to `Damage`) if a future trap effect needs player input mid-resolution, rather than assuming every trap resolves synchronously in one pass.
- Added ESLint, Prettier, and a GitHub Actions CI workflow (lint + format check + typecheck + tests on every change) — process tooling, not a game-rules decision, but recorded here since it's the kind of thing a future handoff should know is now expected to pass.
