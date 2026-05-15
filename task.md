# ST RPG HUD — Build Task List

## Phase 1: Foundation
- `[x]` Create `manifest.json` (extension descriptor)
- `[x]` Create `schema-default.json` (default stat schema: HP/MP/STR/DEX/CON/INT/WIS/CHA)
- `[x]` Create `system-prompt.md` (AI instruction template for lorebook insertion)

## Phase 2: Core Engine
- `[x]` Implement `state.js`
  - `[x]` State object structure with `_version` field
  - `[x]` `loadState(chatId)` / `saveState()` with 500ms debounced disk writes (Adapt BetterSimTracker storage pattern)
  - `[x]` Schema version migration functions (v1→v2 etc.)
  - `[x]` State pruning / garbage collection pass
  - `[x]` GM Edit Mode `setField(path, value)` API (Adopt BetterSimTracker inline edit UX)
  - `[x]` Per-chat `enabledChatIds` set management
  - `[x]` World Info keyword passthrough

- `[x]` Implement `parser.js`
  - `[x]` Bounded Regex (tail 600 chars only)
  - `[x]` Stream-safe buffering (defer parse to GENERATION_ENDED)
  - `[x]` Fail-safe / self-healing for truncated blocks
  - `[x]` `<STAT>` (delta + abs) handler (Adapt BetterSimTracker stat delta math formula)
  - `[x]` `<SKILL>` (add/level/remove) handler
  - `[x]` `<STATUS>` (add/remove) handler
  - `[x]` `<ITEM>` (add/remove/equip/unequip) handler (Include ST-Outfits global variable sync)
  - `[x]` `<QUEST>` (add/step/complete) handler
  - `[x]` `<PARTY>` (add/update/remove with nested RELATIONSHIP, LOADOUT, SKILLS) handler (Adopt BetterSimTracker relationship matrix data structure)
  - `[x]` `<NPC>` (add/move/remove) handler
  - `[x]` `<LOC>` (set/reveal/add) handler
  - `[x]` `<COMBAT>` (active/idle) handler
  - `[x]` `<CHECK>` intercept (pause flow, trigger dice UI)
  - `[x]` `<NOTE>` and `<SCHEMA>` handlers

## Phase 3: UI
- `[x]` Implement `style.css`
  - `[x]` ST CSS variable integration
  - `[x]` Tab panel layout
  - `[x]` Animated vital bars (Adapt BetterSimTracker CSS transition pattern)
  - `[x]` Delta indicator animations (+/- floaters)
  - `[x]` Paper doll slot grid (Match ST-Outfits slot naming convention)
  - `[x]` Zero-JS CSS-only tooltips for skills/statuses/items
  - `[x]` Mobile responsive `@media` breakpoints (swipe card layout)

- `[x]` Implement `hud.html` (static shell template)

- `[x]` Implement `hud.js`
  - `[x]` Tab 1: Overview (vitals, stats, attributes, status badges, combat AP)
  - `[x]` Tab 2: Skills (pills, rank badges, staged injection on click)
  - `[x]` Tab 3: Inventory & Paper Doll (slots grid + backpack + drag-to-use)
  - `[x]` Tab 4: Party (HP/MP bars, loadout, skills, multi-dimensional relationship meters)
  - `[x]` Tab 5: Connections / NPCs (role badges, notes, click-to-mention)
  - `[x]` Tab 6: Quests / Journal (active quests, step checklist, notes)
  - `[x]` Tab 7: Mini-Map (canvas mount)
  - `[x]` Tab 8: Session Log (turn timeline, parse error warnings)

- `[x]` Implement `minimap.js` (Canvas renderer)
  - `[x]` Fog of war tile grid
  - `[x]` Room / Zone / World zoom levels
  - `[x]` Player pos marker
  - `[x]` NPC dots (color-coded by relationship)
  - `[x]` Named location labels
  - `[x]` Click-to-navigate injection

- `[x]` Implement `dice.js`
  - `[x]` Animated D20 overlay
  - `[x]` RNG with stat modifier application
  - `[x]` Auto-inject result to next message context

- `[x]` Implement `macros.js`
  - `[x]` Configurable button list (stored in extension_settings)
  - `[x]` Rendered as quick-tap bar on HUD
  - `[x]` Each button queues a hidden prompt injection

## Phase 4: Entry Point & Wiring
- `[x]` Implement `index.js`
  - `[x]` Register all ST event hooks (MESSAGE_UPDATED, GENERATION_ENDED, CHAT_CHANGED, GENERATE_BEFORE_COMBINE_PROMPTS)
  - `[x]` Per-chat toggle button in ST Extensions panel
  - `[x]` HUD single-instance injection logic (remove old, append new) (Adapt BetterSimTracker UI insertion point DOM placement)
  - `[x]` Context injection with configurable depth (Adapt Megumin-Suite prompt pipeline hook pattern)
  - `[x]` Dynamic Expression trigger (sprite swap on low HP / status effects)
  - `[x]` Audio SFX hooks (optional, toggleable)
  - `[x]` Extension Settings panel (depth slider, toggles, export/import, reset)

## Phase 5: Verification
- `[x]` Unit test `parser.js` pure functions (state diffs)
- `[x]` Test schema migration (v1 → v2)
- `[x]` Test fail-safe parser on truncated XML
- `[x]` Integration test (full chat cycle with test character)
- `[x]` Test per-chat toggle on/off
- `[x]` Test Dice `<CHECK>` overlay flow
- `[x]` Test Export/Import round-trip
