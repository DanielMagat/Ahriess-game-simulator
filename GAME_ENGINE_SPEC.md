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
6. **Main Phase** loop (see §6) — the priority-and-actions phase.  
7. End of turn: discard down to 2 cards in hand; end-of-turn triggers fire.

### Board layout

- 4 lanes. Each lane has: a Location card (assigned pre-game via a draft procedure, not part of either deck), a base health total per player (starts at 10), and each player's **attack sequence** — an ordered list of that player's units in the lane.  
- New units are always appended to the **end** of their side's attack sequence in that lane, regardless of how they got there (played, summoned, or moved in from another lane).  
- A lane is **deactivated** when a base reaches 0; no further combat occurs there.
- **Adjacency**: the four lanes form a ring — lane 1 and lane 4 (leftmost and rightmost) are adjacent to each other, same as any other neighboring pair, not just to their immediate neighbor. This is dynamic, not just the static starting layout: a deactivated lane is effectively removed from the ring, and its two neighbors become adjacent to *each other* instead — e.g. if lane 3 deactivates, lane 2's only remaining neighbors become 1 and 4 (skipping straight over 3). A unit sitting *in* a deactivated lane still uses its own position to ask "what's adjacent to here" (it can still be moved out during Repositioning), even though the lane itself no longer counts as anyone else's neighbor. Once two lanes are deactivated, a unit in either one can reach *both* remaining active lanes — the same skip-over rule, just with a bigger gap. See `resolution/lanes.ts`'s `getEffectiveAdjacentLanes` for the implementation, confirmed against worked examples for one- and two-lane deactivation.

### Repositioning charges

- A resource separate from Energy/Influence, governing how many times units can move lanes during the Repositioning step of combat (§6).
- At the start of Repositioning (i.e., the moment combat is initiated), **both players'** charge pools are set to the current turn number — turn 3 grants 3 charges each, turn 10 grants 10, etc.
- Moving a unit to another lane costs 1 charge by default. `Agile n` (§4 Keywords) lets a unit's first `n` moves that repositioning phase skip the charge cost entirely.
- Charges are per-player, not per-unit — a player spends from one shared pool no matter which of their units they're moving.
- The normal flow: the player selects a unit, the engine offers its *currently* legal destination lane(s) (adjacency, accounting for deactivated lanes — see below), the player picks one, and the engine validates and executes the move. The engine's `isLegalRepositionDestination` hook is where that validation lives — real integration should always back it with `getEffectiveAdjacentLanes`.

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

  id?: string                                  // author-assigned, stable — needed for usage limits and Negate(thisAbilityOnly); omit if neither applies

  trigger: TriggerSpec

  condition?: ConditionExpr

  target?: TargetSpec

  action: Action\[\] | { hook: string }        // composable primitives, OR named escape hatch

  usageLimit?: UsageLimit                      // none / oncePerTurn / oncePerGame / compound — see Usage limits below. Applies to ANY trigger kind, not just Activated.

}

`TriggerSpec` — confirmed trigger points: `EtB`, `Fall`, `SoT` (incl. specific-turn-number variants), `EoT`, priority-window "you may" effects, `StartOfCombat`, during Repositioning, during Trap Placement, end of Trap Placement (*before* the stack resolves — a distinct hook from the resolution itself), Trap resolves, `StartOfDamage`, a unit dealing/taking combat damage, `EndOfCombat`, `LaneDeactivated`, `Activated{cost}`, plus a `Custom` escape variant for anything that doesn't fit cleanly. (`usageLimit` used to be nested inside `Activated` — it's now `Ability.usageLimit`, applying uniformly to any trigger kind; see Usage limits below.)

`TargetSpec` — **no card in the pool uses the word "target."** Selection is always descriptive/positional: lane scope (`this lane` / adjacent / other lanes / all lanes — `this lane` dominates overwhelmingly), allegiance (allied/enemy/each player's), sequence position (first/last-in-sequence — "first" dominates), quantity (single / each matching / any number chosen by the player), zone (hand/graveyard/deck-top-N), rarely random. See §7 for how selection interacts with queued (non-immediate) resolution.

`Action` primitives, by category:

| Category | Primitives |
| :---- | :---- |
| Damage/healing | `dealDamage`, `heal` |
| Card/zone movement | `draw`, `discard`, `exile`, `sacrifice`, `destroy`, `returnToHand`, `search`, `moveUnit`, generic `moveZone` — see below for how these fit together |
| Counters/stats | `addCounter` / `removeCounter`, `buffStat` (permanent or `until X`), `massIncrement` (see Counters below) |
| Board control | `freeze`, `negate` (see Keywords and Negate below — one canonical mechanic, previously mis-split into three names) |
| Cost/economy | `modifyCost` (often conditional, e.g. "1 less per Trap played" — **waiting on real card examples to implement correctly**, see §9), `gainEnergy` (temporary vs. permanent-max), `gainInfluence`, `spendInfluence` |
| Meta-structural | `copy`, `fuse`, `switchForm`, `createToken`, `transform`, `changeCardType` (a handful of cards change a target's card type; bidirectional — `from`/`to` are each a list of `CardType`) |
| Modal/choice | `chooseOne`, `chooseAnyNumber`, `lookAtTopN` \+ rearrange — these are **resolution-time decision points**, not upfront targeting (§7) |

**Duration** (for temporary effects): `untilNextCombat`, `untilEoT`, `untilEndOfCombat`, `untilNextSoT`, `untilPhaseIn`, `untilCondition(expr)`, `permanent`.

**Card/zone movement, worked out**: `moveZone` is the one general mechanism underneath all of it — move a card between two fully-addressed zone locations (`{kind: "hand"|"graveyard"|"deck"|"exile", playerId}`, or `{kind: "battlefield", playerId, laneId, mode?}`). Leaving the battlefield tears the object down (damage discarded, counters kept — the zone-change rule above); entering it creates a fresh one, commits a mode, and adds it to the destination lane's attack sequence and/or structures per its effective types. `discard`, `exile`, and `returnToHand` are the named, card-text-facing vocabulary for specific common cases of this — they delegate to the same mechanism rather than duplicating it, so a card just says "exile this," not "moveZone this to my exile." `search` (below) also produces a `moveZone` call once it's picked a card. The eventual "play a card from hand" is expected to be: pay costs, ask the player which lane, then `moveZone(card, hand, {battlefield, that lane, chosen mode})` — the same call, just from a different starting point. `moveUnit` is deliberately **not** part of this family: it's a same-battlefield, different-lane move (governed by adjacency and Repositioning charges, not by zone rules at all — see below), so it keeps its own mechanism.

**`search`**: matches cards in a zone against criteria — currently `type` and/or `cost` (`eq`/`gt`/`lt` a number), ANDed when both given (e.g. "a unit that costs 5"). Designed to extend to more stats later (power, toughness, keyword...) as one more optional, ANDed field, without a redesign. Checks **both of a card's modes independently** and reports which specific mode(s) qualify — this matters because the two modes can differ in cost and type entirely. Going to hand moves the whole physical card, uncommitted (either mode still playable later, since hand doesn't fix a mode — see Card Data Model above). Going to the battlefield **commits to the specific matching mode** — a card whose mode A costs 1 and mode B costs 6, searched for "costs 1," enters as mode A only, never mode B, even though it's the same physical card. Picking among multiple matching cards, or among multiple qualifying modes of a single match headed to the battlefield, are both genuine player decisions (deck searches are browsed, not auto-picked) waiting on the decision-checkpoint mechanism, same as everything else that needs one; the deterministic cases (one match, one qualifying mode) work today. Defaults to searching the ability's own controller's zone — there's no way yet to search an opponent's zone if a future card needs that (§9).

**`moveUnit`**: takes a concrete destination lane, not a scope to resolve — by the time this executes, "which lane" has already been decided, normally by the player picking one of the options `isLegalRepositionDestination` (backed by lane adjacency, below) currently allows. A card effect that moves a unit via its own Action list needs to have already resolved a concrete destination the same way.

### Negate

The one canonical name for ability/effect suppression (`Negate(scope, duration)` — "SuppressEffects" and "disableThisAbility" from earlier drafts were the same mechanic named inconsistently, not three mechanics), parameterized by scope:

- `thisAbilityOnly`: silences exactly one ability on the target object, leaving its others fully functional. Needs `Ability.id` (§4, Ability/Trigger/Target/Action below) to know *which* one — this is why abilities got an id field at all: a card can have several abilities, and negating one must never touch the others (confirmed requirement — a once-per-turn limit on one ability, for instance, must not affect a different ability on the same card).
- `allAbilitiesOfObject`: silences everything on the target, no id needed.
- `allCardsMatchingName`: structurally different from the other two — it has to reach objects that don't exist yet when it resolves (a copy drawn later, a token created after the fact), so it can't be a per-object status effect the way the other two are. It lives as a global list on `MatchState` instead (`activeNameNegations`) rather than attached to any one object.

Implemented at the type/data level (the `negated` StatusEffect for the first two scopes, the global list for the third) and as pure, tested checking logic (`resolution/abilityAvailability.ts`'s `isAbilityNegated`) — but nothing calls that logic yet, because nothing in the engine automatically fires triggered abilities in the first place (see the new Roadmap item below). The checking rule itself is settled; only its live wiring is still ahead.

### Usage limits

`UsageLimit` (`none | oncePerTurn | oncePerGame | { compound: UsageLimit[] }`) lives on `Ability` itself now, not nested inside the `Activated` trigger the way it was originally drafted — a plain triggered ability ("When \[condition\] is met, draw a card. Once per game.") needs the exact same limiting with no activation cost involved at all, so one general mechanism covers both rather than "usage limits, but only for the one trigger kind that happened to need it first."

Tracked per-instance, per-ability-id, on `CardInstance.abilityUsage` — never on the (static, shared-by-every-copy) `Ability`/`ModeDefinition` data itself, since two copies of the same card (or the same physical card returning to the battlefield later) each need their own independent count, and a `oncePerGame` count needs to survive a zone change the same way counters do (the zone-change rule above). `oncePerTurn` resets implicitly by comparing against the current turn number rather than needing an explicit reset step. Pure logic (`isUsageAvailable`, `recordAbilityUsage`) lives in `resolution/abilityAvailability.ts`, tested including the specific "two abilities on one object track independently" case — same not-yet-wired status as Negate above, for the same reason (no trigger-dispatch loop yet).

**Open**: what `{ compound: UsageLimit[] }` actually composes (twice per game? once per turn *and* once per game together?) is still undefined — see §9.

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

**Negate** — see the dedicated Negate section above (implementation, scopes, and current status).

### Counters

Counter { name: string, count: number, semantics: "builtin" | "generic", polarity: "beneficial" | "detrimental" }

**Built-in** (engine-understood behavior): `+1/+1` / `-1/-1` (permanent stat mod), `shield` (fully prevents the next damage-or-destroy instance, then depletes by 1), `plating` (reduces incoming damage by its current count, then depletes by exactly 1 regardless of how much it blocked — a meaningfully different rule from shield), `poison` (placed by the `Poisonous` keyword; at end of turn, a unit takes damage equal to its poison count — the counters do **not** deplete afterward; a unit keeps ticking for its full poison count every end of turn until something else removes the counters).

**Polarity**: every counter, built-in or generic, is tagged `beneficial` or `detrimental` from its controller's point of view — `+1/+1`, `shield`, `plating` are beneficial; `-1/-1`, `poison` are detrimental. This exists specifically to support `massIncrement` (§4 Action table): mass-incrementing a card increases all of *its* beneficial counters by 1 if the card is allied to the effect's controller, or all of its detrimental counters by 1 if the card is enemy to the effect's controller — so one effect definition covers "mass increment an allied unit/structure here," "mass increment all enemy cards here," and "mass increment all cards everywhere" alike, without the effect needing to know which specific counters exist on the target. This is also why polarity is modeled as a property of the counter rather than hardcoded into `massIncrement` itself as a fixed list of counter names — new counters (including the reworked bespoke ones below) only need a polarity tag to slot into `massIncrement` correctly, not a code change to the action itself.

**Generic** (name \+ number only; all meaning lives in that card's own hook): the bespoke counters observed in the current card pool (mark, reaction, thirst, time, finality, and one card-specific "charge" counter) are being reworked by the designer and are **explicitly not to be implemented yet** — don't build special-case logic for any of them until the rework lands. Once it does, expect there to be a small number of these, each still needing a polarity tag for `massIncrement` purposes, with the rest of their meaning living in that card's own hook rather than generalized engine behavior.

---

## 5\. Match State

MatchState {

  turnNumber, activePlayerId, attackTokenHolderId, attackTokenSpentThisTurn: bool

  phase: StartPhase | MainPhase | Repositioning | TrapPlacement | TrapResolution | Damage | EndPhase

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

  zones: { deck: CardId\[\], hand: CardId\[\], graveyard: CardId\[\], exile: CardId\[\] }

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

**Exile is a real, fully accessible zone — not a "removed from the game" bucket.** It behaves exactly like deck/hand/graveyard: cards sit in it, can be counted, and can be moved out of it by an effect that says so. Some exile effects will still leave a card practically unreachable simply because no card ever references it again ("exile this unit" with no further text) — but that's a property of that specific card's design, not a limitation of the zone itself. Contrast effects like "exile this unit and return it at end of turn" or "this card's power equals the number of allied cards in exile," both of which need exile to be a normal, queryable zone to work at all.

**Traps are global, not per-lane.** A trap is *set* to a specific lane — most of its effects are local to that lane — but all traps on the board resolve from one shared, board-wide LIFO stack, not four independent per-lane stacks. Concretely: if P1 sets a trap to lane 1, then P2 sets a trap to lane 4, P2's trap (set last) resolves first, even though it's a different lane — trap placement order across the whole board determines resolution order, lane assignment doesn't create separate queues.

## 6\. Phase State Machine

A turn is **one continuous priority loop**, not separate pre/post-combat phases — combat is an action available within it, and play resumes in the same loop afterward until both players pass consecutively. This phase is called **Main Phase** in the code (renamed from an earlier "Turn Priority" for clarity — that name is retired; if you see it anywhere, it means "Main Phase").

MAIN\_PHASE:

  legal actions: play card, activate ability,

                 initiate combat (if holds token & unspent),

                 pass (if doesn't hold token, OR already spent it)

  → initiate combat → COMBAT\_REPOSITIONING → COMBAT\_TRAP\_PLACEMENT → COMBAT\_TRAP\_RESOLUTION

    → COMBAT\_DAMAGE → back to MAIN\_PHASE, priority to non-initiator, token marked spent

  → double pass (only reachable once token is spent) → END\_OF\_TURN → next SoT

`COMBAT_REPOSITIONING` and `COMBAT_TRAP_PLACEMENT` are structurally identical to `MAIN_PHASE`: alternating action-or-pass, starting with whoever initiated combat, until both pass consecutively — just with a different legal-action set (spend a charge to move a unit; set a trap face down). This should be **one generic "alternating priority window" procedure**, parameterized by starting player and legal-action set, implemented once and reused three times rather than three separate implementations.

## 7\. Resolution & Targeting Semantics

There is no MTG-style stack of instants, but there **are** two places where an ability sits in a queue rather than resolving the instant it's declared: the **trap stack** (set during placement, resolves LIFO afterward, board-wide — §5) and the **simultaneous-trigger queue**. Anything can happen to the board between an ability being queued and it actually resolving — including a target dying, or a new object appearing that wasn't there when the ability was queued.

Two different rules apply depending on *how* the ability's targets were determined, because the risk each one guards against is different:

- **A player choice** ("choose an enemy unit," or "choose any number of...") is made **when the ability is queued**, and locked in. At resolution, the engine re-validates each locked reference against the *original* selection criteria — existence, location, type/allegiance. Anything that no longer qualifies is dropped silently; the effect applies to whatever survives. Nothing gets re-selected to fill the gap — a new object appearing in the meantime does not retroactively become something the player "chose."
- **An automatic scope** ("each enemy unit here," no player agency in which ones) is the opposite: nothing is decided or locked at queue time at all. It's evaluated **fresh, live, at the moment of resolution** — whoever currently matches the scope gets hit, including anything that showed up after the ability was queued. There's nothing to snapshot against in the first place, since there was never a choice being protected.

This does **not** apply to ordinary Main Phase card resolution — nothing can interleave between an ability being announced and it resolving there, so there's nothing to defer either way; selection and execution are the same instant regardless of which kind of targeting it uses.

QueuedAbility {

  sourceAbilityId, controllerId

  targeting:

    | { kind: "locked", targets: ObjectRef\[\], originalSelectionCriteria }   // player choice, made at queue time

    | { kind: "liveScope", spec: TargetSpec }                                // automatic scope, re-evaluated at resolution

    | { kind: "none" }

}

**Traps never make choices at resolution.** If a trap's ability requires a player choice, that choice happens when the trap is *set* (i.e., at its queue time) and becomes a `locked` targeting, same as any other queued ability — there's nothing left to decide once the trap comes up in the LIFO stack. What a trap's resolution *can* still hit a decision point over is a side effect it causes: e.g. a trap destroys a unit that has "Fall: put a `+1/+1` counter on an allied unit here" — that Fall ability is a separate trigger, with its own player choice, made at *its own* queue time, which happens to fall in the middle of the trap resolving that caused it. The turn machine's contract handles this by design: a trap's resolution halting on such a side-trigger's decision is treated identically to the trap needing the decision itself (see `TurnMachineHooks.resolveTrapEffect` in the engine) — trap resolution stays paused, doesn't advance to Damage, and doesn't lose its place on the stack, regardless of whose choice it's actually waiting on.

**Generalized decision-checkpoint mechanism**: simultaneous-trigger ordering, and resolution-time player choices ("choose one," "choose any number," "look at 3, keep 1") are the same underlying mechanism — any point in resolution requiring player input pauses the engine, emits a decision request, and resumes only once the player responds. One codepath, not a special case per situation. Not yet built (§9/§10) — but per the trap example above, resolution needs to support pausing *inside* something else's resolution, not just at the top level between queue items.

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

- **Compound usage limits** (`UsageLimit`'s `{ compound: UsageLimit[] }` variant) has no defined composition semantics yet — twice-per-game as two `oncePerGame` entries? "Once per turn *and* once per game" combined? The engine currently treats it as always-available (permissive) rather than guessing a possibly-wrong restrictive interpretation. Define this the moment a real card needs it.
- **`search` only searches the ability's own controller's zone.** Every confirmed example is self-targeted ("search YOUR deck for..."); there's no way yet to express "look at target opponent's deck" if a future card needs it.
- **`modifyCost`** isn't implemented — waiting on real card examples (offered, not yet received) to know what "scope"/"condition" actually need to express.

## 10\. Roadmap Recap

1. **Done**: engine scaffolding — types, phase machine, combat resolution (§5–8, implemented and tested against the worked traces above).  
2. **In progress** — ability/effect resolution system: `dealDamage`, `heal`, `freeze`, `buffStat`, `addCounter`/`removeCounter`, `destroy`/`sacrifice`, `draw`, `discard` (targeted only), `returnToHand`, `exile`, `changeCardType`, `massIncrement`, `gainEnergy`, `gainInfluence` (except the `"choice"` color), `spendInfluence`, `moveUnit`, `moveZone`, and `search` (deck/hand/graveyard/exile, both destination kinds) are implemented — including shield/plating mitigation on both combat and non-combat damage, and lane adjacency that correctly accounts for deactivated lanes. Still explicit-but-unimplemented: `negate` and usage limits are built at the type/data/pure-checking-logic level (see the Negate and Usage limits sections above) but not wired to a live consumer — see item 2a below. `copy`/`fuse`/`switchForm`/`createToken`/`transform` need card loading (item 3). `modifyCost` needs real examples (§9). `chooseOne`/`chooseAnyNumber`/`lookAtTopN` wait on the decision-checkpoint mechanism, described next.  
2a. **Trigger-dispatch loop** — newly identified as its own piece of work, not yet started: nothing in the engine currently watches match state for `SoT`/`EtB`/`Fall`/`EoT`/etc. and automatically fires matching abilities; every ability execution so far has been invoked directly (by a test, or eventually by explicit game-loop code), never dispatched automatically. This is the prerequisite for `negate` and usage limits to matter at all (their checking logic exists and is tested, but nothing calls it), and for keywords like Poisonous/Lifelink/Deathtouch/MoraleBreaker to actually do anything beyond being recognized types.  
2b. **Decision-checkpoint mechanism** (§7) — pausing resolution for a player choice — still not built. The trap-resolution pipeline is structured so that when it *is* built, a trap needing a decision correctly blocks progress into Damage rather than being skipped or run out of order; `search`'s multi-match/multi-mode cases and `moveZone`'s "which of several qualifying lanes" case (when driven by a scope rather than a concrete destination) are written to flag rather than guess, ready to hook into this once it exists.  
3. Card loading from data, the local play loop, and a minimal UI.  
4. Deck builder, accounts, persistence.  
5. Server-authoritative multiplayer — same engine, hosted remotely, WebSocket transport.  
6. Monetization/acquisition limits, if ever.

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

**2026-08-30** — Second batch, addressing follow-ups from the first review:
- Shield-vs-plating precedence (§9's open item) confirmed correct as implemented — shield checked first. Item resolved, removed from §9.
- §7 corrected: only *player-chosen* targets are locked at queue time; *automatic scopes* ("each enemy unit here") are evaluated fresh, live, at resolution instead — the previous wording had both locked uniformly, which was wrong. `QueuedAbility.targeting` in the engine now distinguishes `locked` from `liveScope`; `abilityQueue.ts` and its tests were rewritten to match.
- Clarified that traps never make choices at resolution — a trap's own choice, if any, is locked at set/queue time. What CAN still require a decision mid-trap-resolution is a side effect the trap causes (e.g. destroying a unit with a Fall trigger that has its own player choice) — the turn machine's halt-and-hold-your-place contract already covers this correctly regardless of whose choice it's waiting on; see §7.
- "Turn Priority" fully renamed to **Main Phase** throughout this document, matching the code (which had already made this rename). If you see "Turn Priority" anywhere else, treat it as a synonym for Main Phase from an earlier naming pass.

**2026-08-31** — Implemented 8 more `Action` primitives (`discard`, `returnToHand`, `exile`, `changeCardType`, `massIncrement`, `gainEnergy`, `gainInfluence`, `spendInfluence`) and found real design gaps in the process, worth recording so they don't need re-deriving later:
- `exile` has nowhere to actually put an exiled card — PlayerState (§5) only tracks deck/hand/graveyard, no exile zone. Implemented as "removed from the battlefield, tracked nowhere" (matches most removal effects' intent) but genuinely unreachable afterward — nothing can return it, count it, or reference "cards in exile." Needs a real tracked zone added to §5 the moment any card actually cares about interacting with exile as a zone.
- `moveUnit`'s `toLane: LaneScope` can't resolve to a single deterministic destination on a 4-lane wraparound board — `adjacentLanes` alone gives 2 candidates, `otherLanes` gives 3, `allLanes` gives 4. Every real use of this primitive needs a "choose destination lane" decision, which is a different kind of choice than §7's object-targeting mechanism and doesn't exist yet. Left unimplemented rather than guessing a destination (e.g. "always pick the first candidate"). **Superseded, see 2026-09-02 below** — this was a misunderstanding of how repositioning actually works; it's player-driven with a concrete destination by the time the action executes, not a scope the engine needs to resolve.
- `negate` was skipped because nothing in the engine yet automatically fires SoT/EtB/Fall/etc. triggers at all — there's no trigger-dispatch loop watching state changes and executing matching abilities; everything currently runs by a caller manually invoking `queueAbility`/`executeAction`. Storing a "this ability is negated" status effect would have nothing to ever consult it. Worth flagging as a prerequisite this uncovered: the trigger-dispatch loop itself isn't scoped as its own roadmap item yet, and probably should be before too much more of the Action list gets built on the assumption it exists. **Partially superseded, see 2026-09-02 below** — the trigger-dispatch gap is now a roadmap item (§10, 2a); Negate's own data model and checking logic are now built and tested, just still not wired to that loop, which is unchanged from before.
- `changeCardType`'s type tracking follows the same "derive, don't store" pattern as power/toughness (§5's `BattlefieldUnit` doc comment) — a new `typeOverride` status effect, not a stored `currentTypes` field. Its only real consumer right now is its own attackSequence/structures membership update; nothing else in the engine checks an object's type yet (`targeting.ts` has no type filter).
- `massIncrement` only bumps counters a target already has — it never creates one from nothing, matching "increasing all of the beneficial counters ON IT."

**2026-09-02** — Implemented `exile` as a real zone, `search`, lane adjacency (with deactivation), and generalized `moveZone`; scaffolded (but did not wire up) `negate` and usage limits, per a detailed round of clarifications:
- `exile` moved from "removed from the battlefield, tracked nowhere" to a genuine fourth zone on `PlayerState` (alongside deck/hand/graveyard) — cards will need to interact with it later (return-from-exile effects, "count cards in exile" effects), so it has to be queryable like any other zone, not a black hole. §5 updated.
- `search` implemented: criteria are `type` and/or `cost` (`eq`/`gt`/`lt`), ANDed when both present, checked against **both** of a card's modes independently. Going to hand moves the whole card, mode uncommitted; going to the battlefield commits to whichever specific mode actually matched. Defaults to the ability's own controller's zone (§9: no opponent-zone search yet).
- Lane adjacency reworked to account for deactivated lanes: a deactivated lane is skipped over in the ring, its former neighbors become adjacent to each other, and a unit sitting in a deactivated lane still resolves its own effective neighbors for repositioning purposes. Verified against every worked example given, including the two-deactivated-lanes case. New `resolution/lanes.ts`; `targeting.ts`'s older, simpler (deactivation-unaware) version was replaced with this one so the two don't disagree.
- `moveUnit` corrected: takes a concrete destination lane (`toLaneId`), not a `LaneScope` to resolve — repositioning is player-driven with a concrete choice by the time the action executes; the engine offers legal destinations (via the adjacency above) rather than needing to pick among a scope itself. §4/§9 updated to remove the earlier (mistaken) blocker.
- `moveZone` generalized into the one mechanism underlying `discard`/`exile`/`returnToHand` (which now delegate to it rather than duplicating battlefield-entry/exit logic) and, eventually, "play a card" and search's battlefield destination. §4 updated with the worked-out shape.
- `negate` and usage limits (`UsageLimit`, generalized off `Activated` onto `Ability` itself, since a plain triggered ability needing "once per game" is a real, confirmed case) are now real, tested types and pure checking logic (`resolution/abilityAvailability.ts`) — including the specifically-confirmed requirement that two different abilities on the same object track independently. Neither is wired to a live consumer, because nothing in the engine yet automatically fires triggered abilities at all — that gap is now its own roadmap item (§10, 2a) rather than an implicit assumption.
- `modifyCost` still waiting on real card examples (offered).
- §9 cleared of the three long-standing cards.xml data-quality notes (Faceless Giga Armor's cost, the two apostrophe mismatches) — source-data typos, not engine concerns, per the game designer.
