# SillyTavern RPG HUD — Final Implementation Plan (Performance-Audited)

> [!IMPORTANT]
> All open questions are resolved. Every section has been audited for **browser performance** and **LLM token overhead**. This document is the single source of truth before execution begins.

---

## 1. Overview

The **ST RPG HUD** is a SillyTavern third-party extension that:
- Injects a collapsible, tabbed HUD panel beneath the **latest AI message only** in the chat.
- Tracks the player character's full RPG state persistently per-chat (stats, skills, inventory, map, party, quests, connections).
- Receives all state updates exclusively from the AI via a **strict `<RPG-HUD>...</RPG-HUD>` XML block** appended to the end of every AI response.
- Silently strips those tags before the user sees the message, so the chat remains clean prose.
- Feeds a **minified compressed context summary** back into the prompt before every generation using ST's `extension_prompt` API at a configurable injection depth.
- Fully disabled on any chat unless explicitly toggled on (per-chat opt-in).

**Target models:** GLM-4 / Kimi K2 (both parse strict XML without leakage).

---

## 2. File Structure

```
public/scripts/extensions/third-party/st-rpg-hud/
├── manifest.json          ← ST extension descriptor
├── index.js               ← Entry point, event wiring
├── state.js               ← Persistent state manager (per chat)
├── parser.js              ← Strict XML extractor + state diff engine
├── hud.js                 ← HUD DOM builder + tab renderer
├── hud.html               ← Static HTML template shell
├── minimap.js             ← HTML5 Canvas fog-of-war tile engine
├── dice.js                ← Dice roll overlay + RNG engine
├── macros.js              ← Configurable quick-action buttons
├── style.css              ← ST-theme-aware CSS (responsive)
├── schema-default.json    ← Fallback stat schema (HP/MP/STR/etc.)
└── system-prompt.md       ← AI instruction template for lorebook
```

---

## 3. Core Engine Architecture

### 3.1 Per-Chat Opt-In Toggle
- The extension does **nothing** unless the user explicitly enables it for a chat.
- A toggle button is placed in the ST extensions side panel.
- The enabled state is stored as a set of `enabledChatIds` in `extension_settings`, keyed by the chat's unique ID.
- On `CHAT_CHANGED`, the extension checks if the new chat is in the enabled set. If disabled, **all event listeners are deregistered** and no hooks fire — true zero cost.

### 3.2 State Manager (`state.js`)
The central state object per chat is structured and versioned:
```json
{
  "_version": 2,
  "chatId": "abc-123",
  "character": { "name": "...", "schema": "default" },
  "vitals": { "hp": 80, "hp_max": 100, "mp": 40, "mp_max": 60, "sta": 70, "xp": 1500, "gold": 250 },
  "stats": { "str": 14, "dex": 12, "con": 13, "int": 16, "wis": 10, "cha": 8 },
  "skills": [ { "name": "Fireball", "rank": 2, "desc": "Shoots a 3d6 fire projectile" } ],
  "status_effects": [ { "name": "Poisoned", "turns": 3, "desc": "Lose 5 HP/turn" } ],
  "inventory": [ { "name": "Health Potion", "type": "consumable", "qty": 3 } ],
  "equipped": { "head": null, "body": null, "weapon": null, "offhand": null, "ring1": null, "ring2": null, "accessory": null },
  "party": [
    {
      "name": "Serana",
      "hp": 80, "hp_max": 100, "mp": 50, "mp_max": 80,
      "status": ["poisoned"],
      "loadout": { "weapon": "Elven Bow", "accessory": "Amulet of Bats" },
      "skills": [ { "name": "Vampiric Drain", "desc": "Steals 10 HP from target" } ],
      "relationship": { "trust": 80, "affection": 75, "lust": 20, "fear": 0, "respect": 60, "rivalry": 10 }
    }
  ],
  "connections": [ { "name": "Aldric", "role": "ally", "note": "Blacksmith in Riverhold" } ],
  "quests": [ { "name": "Slay the Dragon", "status": "active", "steps": ["Find the cave"], "completed_steps": [] } ],
  "combat": { "active": false, "turn": 0, "ap": 3, "ap_max": 3 },
  "map": {
    "current_location": "Dark Cave",
    "zoom": "zone",
    "player_pos": [5, 5],
    "revealed_tiles": [[4,5],[5,5],[6,5]],
    "npcs": [ { "name": "Goblin Scout", "rel": "hostile", "x": 7, "y": 4 } ],
    "named_locations": [ { "name": "Dark Cave", "type": "dungeon", "x": 5, "y": 5 } ]
  },
  "notes": [],
  "session_log": []
}
```

**Manager responsibilities:**
- `loadState(chatId)` / `saveState()` with **debounced disk writes** (~500ms) to prevent micro-stutters.
- **Schema version migration**: On load, if `_version < current`, run incremental migration functions to safely upgrade the structure without losing data.
- **State pruning (Garbage Collection)**: On every `saveState()` call, remove dropped items, removed NPCs, and expired status effects (`turns <= 0`) from the raw object so the context injection string stays compact.
- **GM Edit Mode API**: Exposes `setField(path, value)` for direct human overrides when the AI hallucinates wrong values.
- **Session log rotation**: Hard cap at **100 entries**. Oldest entries are silently dropped. Session log is never serialized into the context injection — it is UI-only data.

> [!WARNING]
> **Performance rule:** `session_log` and `notes` are **excluded** from context injection. They exist only for the HUD UI. Including them would balloon token usage with no benefit — the AI doesn't need a changelog of its own actions.

### 3.3 AI Parser (`parser.js`)
**Strict format — no ambiguity:**
The AI is instructed to ALWAYS place one `<RPG-HUD>...</RPG-HUD>` block at the absolute end of its response.

**Delta-only contract:**
The AI outputs **only fields that changed this turn**. It does NOT re-dump the full state every response. This is the single most important token-saving rule.

**Extraction strategy (performance-first):**
```js
// Only scan the last 600 characters — never the full message body
const tail = rawText.slice(-600);
const match = tail.match(/<RPG-HUD>([\s\S]*?)<\/RPG-HUD>/);
```
This cuts CPU usage by ~95% compared to full-string Regex on long messages.

**Stream-safe buffering:**
- During `event_types.MESSAGE_UPDATED` (streaming chunks), the extension **only** does a lightweight string check for `<RPG-HUD` to decide whether to hide trailing text. No Regex, no DOM mutation, no state computation.
- On `event_types.GENERATION_ENDED`, the full extraction + state diff + HUD re-render fires **once** cleanly.

**Fail-safe / self-healing:**
- If the AI hits a token limit mid-block, the `<RPG-HUD>` will be partially cut off.
- The parser detects unclosed `</RPG-HUD>`, swallows the broken fragment from the visible text, and attempts to parse any fully-formed child elements within the partial block using individual `<TAG ... />` regex.
- Broken/malformed blocks are logged to `session_log` as `[Parse Error]` entries (capped at 100 entries total).

### 3.4 Context Injection (`index.js`)

> [!IMPORTANT]
> **This is the #1 LLM overhead concern.** Every token we inject is a token the user pays for. The entire injection pipeline is designed around a hard budget.

Before every generation (`event_types.GENERATE_BEFORE_COMBINE_PROMPTS`):
1. **Gate check**: If this chat is not in `enabledChatIds`, return immediately. Zero cost.
2. Pull current state, run state pruning pass.
3. Serialize to **minified key-aliased JSON** using a **tiered truncation budget**:

**Context injection budget: hard cap ≤ 200 tokens (~800 characters)**

Priority tiers (if budget overflows, lower tiers are dropped first):
| Priority | Data | Example |
|---|---|---|
| **P0 (always)** | Vitals + combat state | `h:80/100,m:40,g:250,xp:1500,cmbt:{t:4,ap:1/3}` |
| **P1 (always)** | Currently equipped items (names only) | `eq:{w:"Iron Sword",h:"Iron Helm"}` |
| **P2 (always)** | Active status effects | `fx:["Poisoned(3t)"]` |
| **P3** | Active quest names | `q:["Slay the Dragon"]` |
| **P4** | Party summary (name + HP only) | `pty:[{n:"Serana",h:60/100}]` |
| **P5** | Current location name | `loc:"Dark Cave"` |
| **P6 (dropped first)** | Skill names (no descriptions) | `sk:["Fireball","Heal"]` |

> Skills already have `desc` stored client-side. The AI doesn't need the `desc` re-injected — it only needs the name to know what's available. The `desc` is for the **user's tooltip** and for **World Info keyword matching**, not for re-prompting the AI.

4. Inject via ST's `setExtensionPrompt()` at a **user-configurable depth** (default: 4 from bottom).
5. Run **World Info auto-trigger**: push a **capped maximum of 10 keywords** (prioritized: equipped items > active quest > current location > party names) into ST's World Info keyword scanner. This cap prevents lorebook flooding which could consume thousands of tokens on a rich lorebook.

---

## 4. HUD Interface — Tabs & Panels

**DOM performance rules:**
- The HUD is built using a **`DocumentFragment`** first, then appended to the DOM in a single reflow. No piecemeal `appendChild` calls.
- **Lazy tab rendering**: Only the currently visible tab's content is in the DOM. Switching tabs swaps innerHTML. Inactive tabs are not rendered — this prevents 8× DOM overhead.
- On the next message, the prior HUD instance is removed and all its event listeners are cleaned up (`AbortController` pattern) to prevent memory leaks.
- The HUD panel is a single `<div class="rpg-hud-panel">` inserted directly after the last `.mes` block.

### Tab 1 — Overview (Vitals)
- HP / MP / Stamina animated bar fills using **CSS `transform: scaleX()` transitions** (GPU-composited, no layout thrash — NOT `width` transitions).
- XP progress bar to next level.
- Core attribute grid (STR / DEX / CON / INT / WIS / CHA) with auto-calculated modifier.
- Gold / currency display.
- **Delta Indicators**: Animated `−12` (red) or `+50` (green) floating text using CSS `@keyframes` with `transform: translateY()` + `opacity` only (GPU-only, zero layout cost). Auto-removed after 1.5s via `animationend` event.
- Active status effects as badge chips with **CSS-only `::after` hover tooltips** showing their mechanical effect — zero JS overhead.
- Combat active indicator: Turn counter + AP pips (hidden when `combat.active === false`).

### Tab 2 — Skills
- Player's skill list as pills with rank badge.
- Each skill has a **CSS `::after` tooltip on hover** showing its `desc` field.
- Clicking a skill **stages it** (queued prefix injection: `*[Player] uses Fireball*`) that goes out with the next message the user sends.
- Uses **event delegation** on the skill container (single listener), not per-pill listeners.

### Tab 3 — Inventory & Equipment
- **Paper Doll**: Visual equipment slots grid (Head / Body / Weapon / Off-Hand / Ring 1 / Ring 2 / Accessory). AI uses `slot` attribute on `<ITEM>` tags to populate them.
- **Backpack**: All unequipped items as cards with type badges (weapon / armor / consumable / misc).
- **Click-to-Use**: Click an item card → shows a small "Use / Drop" action menu → queues `*[Player] uses [Item Name]*` injection. (Simpler and more mobile-friendly than drag-and-drop, which has heavy touch-event overhead.)
- Currency display at bottom.

### Tab 4 — Party
- Card per party member showing: portrait placeholder, name, HP/MP bars, active statuses.
- **Loadout row**: Weapon + Accessory currently equipped.
- **Skills accordion**: List of their skills with hover tooltips for `desc`.
- **Relationship Matrix**: Visual meters for each of: Trust / Affection / Lust / Fear / Respect / Rivalry — simple colored `<div>` bars with percentage `scaleX()` fills.

### Tab 5 — Connections (NPCs & Factions)
- Named NPCs with role tag (ally / neutral / hostile / unknown).
- Short note field per NPC.
- Faction standings list if defined in schema.
- Clicking an NPC name queues a hidden context injection mentioning them.

### Tab 6 — Quests / Journal
- Active quests with step checklist (AI ticks steps via `<QUEST>` tags).
- Completed quests collapsed in a separate section.
- Free-form notes injected by the AI via `<NOTE>`.

### Tab 7 — Mini-Map
- HTML5 Canvas tile renderer, contained within the HUD tab panel (no floating).
- **Render-on-demand**: The Canvas only redraws when the Map tab is opened or when state changes while the tab is visible. If the user is on the Overview tab, map canvas is idle — zero GPU cost.
- **Fog of War**: Unrevealed tiles rendered as dark obscured cells.
- Three zoom levels: Room / Zone / World (toggled in-UI).
- Player marker + NPC dots colored by relationship (green = ally, red = hostile, amber = neutral).
- Clicking a revealed named location queues a navigation intent injection.

### Tab 8 — Session Log
- Scrollable `<div>` with `overflow-y: auto` (no virtual scroll needed — capped at 100 entries).
- Each entry: `[Turn 4] HP −10 (dragon bite)`.
- Parse errors appear here as amber warnings.
- Exportable as plain text (copies to clipboard).

---

## 5. AI Tag Protocol (Full Reference)

> [!IMPORTANT]
> **Delta-only rule**: The AI outputs ONLY the tags for values that changed this turn. It does NOT re-dump the entire character sheet each response. A typical turn should have 2–5 tags, not 20+. This is enforced in the system prompt.

All tags live inside a single `<RPG-HUD>…</RPG-HUD>` block placed at the end of the AI response.

```xml
<RPG-HUD>
  <!-- Vitals — use delta for changes, abs for absolute set -->
  <STAT name="HP" delta="-10" />
  <STAT name="MP" abs="40" />
  <STAT name="XP" delta="+150" />
  <STAT name="GOLD" delta="-25" />
  <STAT name="LEVEL" abs="5" />

  <!-- Combat state -->
  <COMBAT mode="active" turn="4" ap="1" ap_max="3" />
  <COMBAT mode="idle" />

  <!-- Skills -->
  <SKILL action="add" name="Fireball" rank="2" desc="Shoots a 3d6 fire projectile at one target" />
  <SKILL action="level" name="Fireball" rank="3" />
  <SKILL action="remove" name="Fireball" />

  <!-- Status effects -->
  <STATUS action="add" name="Poisoned" turns="3" desc="Lose 5 HP each turn" />
  <STATUS action="remove" name="Poisoned" />

  <!-- Inventory -->
  <ITEM action="add" name="Iron Helmet" slot="head" type="armor" desc="Basic iron helm, AC+1" />
  <ITEM action="remove" name="Iron Helmet" />
  <ITEM action="equip" name="Iron Helmet" slot="head" />
  <ITEM action="unequip" name="Iron Helmet" />

  <!-- Quests -->
  <QUEST action="add" name="Slay the Dragon" desc="A bounty from the guild" />
  <QUEST action="step" name="Slay the Dragon" step="Entered the Dark Cave" />
  <QUEST action="complete" name="Slay the Dragon" />

  <!-- Party (delta-only: only include changed fields) -->
  <PARTY action="add" name="Serana" hp="100" hp_max="100" mp="80" mp_max="80">
    <LOADOUT weapon="Elven Bow" accessory="Amulet of Bats" />
    <SKILLS>
      <SKILL name="Vampiric Drain" desc="Steals 10 HP from target per hit" />
    </SKILLS>
    <RELATIONSHIP trust="80" affection="75" lust="20" fear="0" respect="60" rivalry="10" />
  </PARTY>
  <PARTY action="update" name="Serana" hp="60" status="poisoned">
    <RELATIONSHIP trust="85" affection="78" />
  </PARTY>
  <PARTY action="remove" name="Serana" />

  <!-- Connections / NPCs -->
  <NPC action="add" name="Aldric" role="ally" note="Blacksmith in Riverhold" x="3" y="7" />
  <NPC action="move" name="Aldric" x="4" y="7" />
  <NPC action="remove" name="Aldric" />

  <!-- Map -->
  <LOC action="set" name="Dark Cave" x="5" y="5" zoom="zone" />
  <LOC action="reveal" x="6" y="5" />
  <LOC action="add" name="Hidden Shrine" type="landmark" x="9" y="2" />

  <!-- Dice check (pauses generation, prompts user to roll) -->
  <CHECK stat="WIS" dc="12" />

  <!-- Notes (appended to Journal tab) -->
  <NOTE text="The blacksmith mentioned a secret passage behind the waterfall." />

  <!-- Schema override for custom card systems -->
  <SCHEMA override="{...}" />
</RPG-HUD>
```

> [!IMPORTANT]
> The system prompt instructs the AI: **"Always place the `<RPG-HUD>` block as the very last thing in your response, after all prose. Only include tags for things that actually changed this turn."** This is the contract that makes bounded-Regex parsing safe, fast, and token-cheap.

---

## 6. Performance & Token Overhead Audit

### Browser Performance

| Concern | Mitigation | Impact |
|---|---|---|
| **Regex on long messages** | Bounded to last 600 chars only | ~95% CPU saved per parse |
| **DOM bloat (8 tabs)** | Lazy rendering — only active tab is in DOM | ~87% fewer DOM nodes |
| **DOM reflow** | Build HUD in `DocumentFragment`, append once | Single reflow per render |
| **CSS animations** | All animations use `transform` + `opacity` only (GPU-composited) | Zero layout thrash |
| **Event listeners** | Event delegation (1 listener per container, not per element) + `AbortController` cleanup on HUD removal | Zero memory leaks |
| **Minimap Canvas** | Render-on-demand — only draws when Map tab is active | Zero GPU cost when hidden |
| **Disk I/O** | `saveState()` debounced at 500ms | Max 2 writes/sec |
| **Stream rendering** | Lightweight `indexOf('<RPG-HUD')` check during streaming, no Regex | Negligible CPU during stream |
| **Audio SFX** | Lazy-loaded on first play, cached thereafter. Not preloaded. | Zero memory cost until used |
| **Session log** | Capped at 100 entries, oldest dropped | Bounded memory |
| **Inventory interaction** | Click-to-use (not drag-and-drop) | No touch-event polyfill overhead on mobile |
| **Mobile layout** | CSS `@media` only — no JS resize observers | Zero runtime cost |

### LLM Token Overhead

| Concern | Mitigation | Token Cost |
|---|---|---|
| **System prompt (AI instructions)** | Compressed to ≤ 300 tokens. Uses bullet format, no prose. One-shot example included. | ~300 tokens (one-time per conversation) |
| **Context injection per turn** | Hard budget of ≤ 200 tokens. Tiered priority with truncation. | ≤ 200 tokens/turn |
| **AI output overhead per turn** | Delta-only contract: AI only outputs changed fields. Typical turn = 2–5 tags. | ~30–80 tokens/turn |
| **World Info flooding** | Keyword cap at 10 active keywords per scan | Bounded lorebook injection |
| **Skill descriptions re-injected** | NO — `desc` is stored client-side only. Not included in context injection. | 0 extra tokens |
| **Session log re-injected** | NO — session log is UI-only data. Never sent to the AI. | 0 extra tokens |
| **Notes re-injected** | NO — notes are UI-only. The AI already wrote them; it doesn't need them back. | 0 extra tokens |
| **Full party details re-injected** | NO — only `name + HP` summary for each party member (P4 tier). Full skills/relationships are client-only. | ~15 tokens per party member |

**Total estimated per-turn LLM overhead:** ~230–280 tokens (context injection + AI output tags combined).
For comparison, a single normal conversational turn is typically 200–500 tokens. The overhead is ~50% of a message — reasonable for a full RPG engine.

> [!CAUTION]
> If the user's prompt template already consumes most of the context window, the 200-token injection budget can be reduced to 100 via the Settings panel depth slider. The system gracefully drops lower-priority tiers.

---

## 7. UX Features (Summary)

| Feature | Detail |
|---|---|
| **Per-Chat Toggle** | On/Off button in ST Extensions panel — state stored by Chat ID |
| **GM Edit Mode** | Unlock field editing for human error correction — re-locks automatically |
| **Dice Roll UI** | `<CHECK>` tag triggers animated D20 overlay; result auto-injected |
| **Quick Macros** | Configurable `[Attack]` / `[Flee]` / `[Search]` etc. buttons |
| **Action Economy** | Turn + AP tracker in Overview visible during `<COMBAT mode="active">` |
| **Delta Indicators** | Animated +/− floaters on vital bars every turn (GPU-only CSS) |
| **Dynamic Expressions** | Hooks ST Sprite system — auto-switches expression on low HP or status |
| **Export / Import** | Full character state to/from `.json` file |
| **Audio SFX** | Optional and lazy-loaded. Sounds on item pickup, level up, new quest (toggleable) |
| **Mobile Layout** | CSS-only `@media` collapses Paper Doll and Map into stacked cards on small screens |

---

## 8. System Prompt Template (Summary)

The `system-prompt.md` file is designed to be inserted in the character's lorebook or as a System Prompt block. **Budget: ≤ 300 tokens.**

Key rules it teaches the AI:
1. Always append ONE `<RPG-HUD>` block per response, at the very end after all prose.
2. Never output `<RPG-HUD>` mid-sentence or mid-paragraph.
3. **Delta-only**: Only include tags for values that actually changed this turn. Do NOT re-output the full character sheet.
4. Use `delta` for relative changes, `abs` for absolute value resets.
5. Skill `desc` must be one short mechanical sentence (under 12 words).
6. When in combat, always output `<COMBAT turn="N" ap="N" ap_max="N"/>`.
7. A typical turn should have 2–5 tags. Turns with 10+ tags are unusual and should only happen during major events (level up, shop visit, party change).

---

## 9. Verification Plan

### Functional Testing
- `parser.js` unit tests: Feed sample XML → assert correct state diffs.
- `state.js` migration test: Open a v1 state → assert v2 migration runs cleanly.
- Inject test messages with truncated `<RPG-HUD>` blocks → confirm fail-safe swallows them without exposing raw text.
- Context injection test: Generate a max-size state object → assert serialized output ≤ 800 characters.

### Performance Testing
- Measure `parser.js` execution time on a 5,000-character message → must be < 1ms.
- Confirm zero unnecessary DOM mutations during streaming via DevTools Performance tab.
- Confirm HUD removal properly disposes event listeners (heap snapshot before/after).

### Integration Testing (Manual)
1. Enable extension, enable HUD on a test chat.
2. Send a message that triggers AI to output a full `<RPG-HUD>` block.
3. Confirm: raw XML not visible in the rendered chat message.
4. Confirm: HUD panel appears below the message with correct values.
5. Confirm: vitals update correctly compared to the delta tags.
6. Confirm: clicking a skill queues the injection and it appears in the next sent message's context.
7. Test `<CHECK>` tag — confirm Dice overlay appears and blocks sending until rolled.
8. Test per-chat toggle: disable, send message, confirm HUD does not appear and no hooks fire.

---

## 10. Extension Settings Panel (UI in ST)

A settings section in ST's Extensions drawer will expose:
- Master enable toggle (same as the per-chat button — synced).
- Context Injection Depth slider (1–10, default 4).
- Context Budget slider (100–300 tokens, default 200).
- Audio SFX toggle (default: off).
- GM Edit Mode toggle.
- Export Character / Import Character buttons.
- Reset HUD State for current chat button (irreversible, shows confirmation).

> [!CAUTION]
> GLM-4 and Kimi K2 handle strict XML reliably. However, if a user switches to a weaker model mid-chat, the AI may fail to produce the `<RPG-HUD>` block. In this case, the HUD simply won't update that turn — it will not crash or corrupt state.

---

## 11. Code Adaptation Map (From Installed Extensions)

Before writing any code from scratch, the following patterns, formulas, and APIs **must be adapted** from these already-installed and working extensions. This avoids reinventing the wheel and ensures compatibility.

---

### 11.1 — BetterSimTracker (`third-party/BetterSimTracker/src/`)
**Priority: HIGH — Most overlap. Study these files before coding `state.js`, `parser.js`, and `hud.js`.**

| What to Adapt | Source File | Notes |
|---|---|---|
| **Stat delta math formula** | `src/index.ts` (lines ~182–217 in README) | `scaledDelta = round(clampedDelta * scale)` where `scale = (1 - dampening) + confidence * dampening`. Adapt for HP/MP combat damage and XP gain. |
| **`GENERATION_ENDED` event hook** | `src/index.ts` + `src/runtimeEventHelpers.ts` | Triggers state processing only after full generation. Our parser must fire on this same event, not during streaming. |
| **`saveSettingsDebounced()` pattern** | `src/storage.ts` | BST uses ST's built-in `saveSettingsDebounced()` with a timer gate. Copy this exact debounce approach for `state.js`. |
| **Per-chat state keyed by chat ID** | `src/storage.ts` | BST stores snapshots keyed by message index + chat ID. We key by Chat ID only. Same `extension_settings` storage mechanism. |
| **Schema version `_version` migration** | `src/storage.ts` + `src/types.ts` | BST has incremental migration functions. Copy the migration pattern (check `_version`, run upgrade functions in sequence). |
| **Prompt injection via `setExtensionPrompt()`** | `src/promptInjection.ts` | BST uses ST's `setExtensionPrompt(extensionName, text, depth)`. This is the exact API we call for context injection. |
| **Lorebook keyword passthrough** | `src/lorebook.ts` | BST scans active lorebook context and passes terms to the WI scanner. Replicate this for World Info auto-triggering. |
| **DOM injection below `.mes` element** | `src/ui.ts` | BST inserts tracker cards directly into each `.mes` DOM element after generation. Our HUD uses the same injection point. |
| **Debounced render queue** | `src/renderQueueHelpers.ts` | Prevents multiple rapid re-renders. Apply same pattern to our `hud.js` render calls. |
| **GM Edit Mode UX (pencil icon → inline edit)** | `src/editStatsModal.ts` + `src/trackerEditState.ts` | BST's inline stat edit flow is exactly our GM Edit Mode. Copy the lock/unlock UX pattern and numeric clamp logic. |
| **CSS bar fills + stat update animations** | `src/index.ts` (CSS in style tag) | BST has per-stat colored bars with subtle update animations and reduced-motion support. Copy the CSS `transition` and `@keyframes` patterns. |
| **`CHAT_CHANGED` cleanup hook** | `src/index.ts` | BST deregisters state and cleans the UI on chat change. Our per-chat toggle cleanup must follow the same pattern. |
| **Relationship matrix data model** | `src/types.ts` | BST tracks `affection`, `trust`, `desire`, `connection` per character. We extend this with `lust`, `fear`, `respect`, `rivalry`. Use their data type shape as the base. |

> [!NOTE]
> BST is TypeScript compiled to `dist/index.js`. Read the **`src/`** files for reference — do NOT copy compiled output. Our extension is plain JS, so manually translate the patterns, not the code verbatim.

---

### 11.2 — ST-Outfits (`third-party/ST-Outfits/`)
**Priority: HIGH — Paper Doll system + cross-extension compatibility.**

| What to Adapt | Source File | Notes |
|---|---|---|
| **Equipment slot naming convention** | `index.js` + `README.md` (variable list) | ST-Outfits uses: `headwear`, `topwear`, `topunderwear`, `bottomwear`, `bottomunderwear`, `footwear`, plus 12 accessory slots. Our paper doll must use **compatible slot names** so ST-Outfits stays in sync. |
| **Auto-equip flow (AI-triggered updates)** | `index.js` (`Auto Outfit Updates` section) | After our `<ITEM action="equip">` parser runs, also call `setGlobalVariable('<BOT>_<slotname>', itemName)` — same GlobalVar pattern ST-Outfits uses — so both extensions see the same equipment state. |
| **"Use/None to remove" convention** | `README.md` | When our `<ITEM action="unequip">` fires, write `"None"` to the corresponding global var. Consistent with ST-Outfits behavior. |
| **Per-character namespacing** | `index.js` | ST-Outfits scopes by char name (`<BOT>_slot`). We scope by Chat ID. Both can coexist if our equip handler also writes the global var. |

> [!IMPORTANT]
> **Cross-extension bridge:** When the RPG HUD processes an `<ITEM action="equip" slot="head">` tag, it should write both to our own state AND to ST's global variable (`setGlobalVariable('CharName_headwear', 'Iron Helmet')`). This means users who have both extensions installed get automatic outfit tracker sync for free, with zero extra prompting cost.

---

### 11.3 — Megumin-Suite (`third-party/Megumin-Suite/`)
**Priority: MEDIUM — Prompt pipeline event hook pattern.**

| What to Adapt | Source File | Notes |
|---|---|---|
| **`CHAT_COMPLETION_SETTINGS_READY` prompt injection hook** | `index.js` → `handlePromptInjection(data)` (line ~714) | Megumin hooks into ST's message array before generation and mutates `messages[i].content`. Our context injection can use the same hook to append the minified state JSON. Study the message iteration loop. |
| **Trigger cleanup pass** | `index.js` → `handlePromptInjection()` (line ~764 cleanup block) | After substitution, Megumin strips leftover `[[trigger]]` tokens. We should strip our own internal markers similarly after injection. |
| **Per-character profile keyed by `avatar` filename** | `index.js` → `getCharacterKey()` (line ~222) | Megumin keys profiles by `context.characters[context.characterId].avatar`. This is the stable character identity key. Use the same approach for our per-character schema defaults. |
| **`saveSettingsDebounced()` with visual indicator** | `index.js` → `saveProfileToMemory()` (line ~272) | Megumin flashes an "Autosaved" indicator after every debounced save. Copy this UX for our settings panel. |

> [!WARNING]
> **Depth conflict risk:** Megumin injects prompts into the message stack and RPG HUD injects via `setExtensionPrompt()`. Both must use **different depth values** (e.g., Megumin at depth 2, RPG HUD at depth 4) to prevent one overwriting the other. This must be tested together.

---

### 11.4 — SillyTavern-MemoryBooks (`third-party/SillyTavern-MemoryBooks/`)
**Priority: LOW — Future enhancement only, no immediate code adaptation.**

| What to Adapt | When | Notes |
|---|---|---|
| **Quest Completion → Lorebook Memory Bridge** | Future v2 feature | When a quest is marked `<QUEST action="complete">`, optionally trigger a MemoryBooks-style lorebook entry summarizing the quest arc. This preserves long-term narrative continuity beyond a single chat's context. |
| **Side Prompt Tracker concept** | Reference only | MemoryBooks' "Side Prompts as Trackers" (inventory, stats, relationships, quest progress) is conceptually what our context injection does — but automatically. No code to copy; use as architectural validation that our approach is sound. |

---

## 12. Compatibility Notes

| Extension | Status | Action Required |
|---|---|---|
| **BetterSimTracker** | ✅ Compatible | Both inject below `.mes`. BST tracks *relationship* stats, RPG HUD tracks *game* stats. No conflict. Test injection depth ordering. |
| **ST-Outfits** | ✅ Compatible (bridged) | RPG HUD equip handler writes to ST global vars to keep both in sync. |
| **Megumin-Suite** | ⚠️ Test Required | Both modify the prompt pipeline. Set different injection depths. Verify no prompt assembly conflict. |
| **MemoryBooks** | ✅ Compatible | Fully separate system. Optional future bridge for quest archival. |
| **All others** | ✅ No overlap | Roadway, JS-Slash-Runner, inline-image-viewer — no conflicts. |
