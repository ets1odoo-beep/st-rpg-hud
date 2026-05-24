# ST RPG HUD — v4 Optimisation & Feature Plan

**Date:** 2026-05-23
**Current version:** 3.0.0 (manifest) / 4.0.0 (code log)
**Target:** Drastically cut token usage while improving real-time world sim, VIR integration, and HUD UX.

> **VIR extension stance:** `ff4-vir-lorebook-sync` is **optional**. Every improvement in this plan works standalone. Where VIR integration is mentioned (B.1, B.2, C.1), it is always opt-in via a HUD settings toggle, auto-detected at runtime, and falls back gracefully when the extension is absent. The RPG HUD ships as a fully self-contained system.

---

## 1. Token Budget Diagnosis (current state)

| What | When | Approx tokens |
|---|---|---|
| `system-prompt.md` (full RULE 1–6 + field reference) | Every turn if used as constant lorebook | ~2 800 |
| `FORMAT_REMINDER` (schema example) | Every turn hardcoded in `buildPromptText()` | ~400–600 |
| Full state dump (vitals + NPCs + quests + facts + VIR + personas + key moments + relationships + scene objects) | Every turn | ~300–800 |
| Off-scene NPCs (even compact) | Every turn when `budget !== 'compact'` | ~100–300 |
| VIR registry block | Every turn when VIR has entries | ~200–600 |
| **Total mid-game** | | **~4 000–5 000 tokens/turn** |

The VIR extension (`ff4-vir-lorebook-sync`) already solved this with tiered keyword-gated lorebook entries. This plan ports the same model here.

---

## 2. Priority Tier

```
TIER A — Token saving (do first, biggest ROI)
TIER B — Quality / consistency (do second)
TIER C — UX / features (do when A+B are stable)
```

---

## 3. TIER A — Token Savings

### A.1 — Delta-only `rpg` blocks (biggest single saving)

**Problem:** The AI is instructed to "reproduce all values" every turn, making it echo unchanged fields. On a calm dialogue turn, the rpg block is 80% redundant echo.

**Fix:**
- Change the system prompt instruction and FORMAT_REMINDER to **delta-only output**: AI only writes fields that changed this turn.
- Extension merges the delta into the persisted state with `deepMerge`.
- Every 10 turns (or when `_parseMisses > 0`) inject a "heartbeat" flag in the state injection: `"FULL_ECHO_REQUESTED": true` → AI writes all fields once to resync. Prevents silent drift.
- Add a `_lastFullEchoTurn` counter; trigger full echo when: turn mod 10 === 0, or after parse miss, or on location change.

**Saving:** ~60–80% reduction in rpg block size on calm turns. A dialogue turn rpg block might drop from 800 tokens to ~80.

---

### A.2 — Tiered state injection (port from VIR extension model)

Currently `buildPromptText()` builds one flat string. Replace with 4 tiers injected at different depths via separate `setExtensionPrompt` calls:

**TIER 1 — Always, depth 4 (~60 tokens):**
```
Vitals | Location | Time | Combat (if active) | Active Goal | Status effects
```
This is all the AI needs 90% of turns. Never omitted.

**TIER 2 — Scene-gated, depth 3 (~100–200 tokens):**
People in `map.peopleHere` → their NPC card (full). Scene objects. Active quests (one line each). Active outfit. Equipped items.
Only injected if the scene has tracked NPCs or active state.

**TIER 3 — Keyword-gated lorebook entries (0 tokens until triggered):**
Each NPC who is **off-scene** becomes a ST lorebook entry with their name as the keyword. Zero tokens until their name appears in the chat. Same model as VIR `OFFSCREEN` tier.
Each faction gets a lorebook entry keyed by faction name.

**TIER 4 — Event-triggered, depth 1 (~50 tokens, temporary):**
Injected only for the turn where a specific event triggers:
- combat starts → combat rules reminder
- quest update → quest step detail
- parse miss → escalated format reminder
- new NPC first appearance → their persona + VIR
Cleared automatically next turn.

**Implementation:** `buildPromptText()` splits into `buildTier1()`, `buildTier2()`, writes off-scene NPCs to lorebook entries on state change, handles tier 4 as a one-shot injection.

---

### A.3 — Adaptive FORMAT_REMINDER

**Problem:** The full JSON schema example (~400 tokens) fires every turn regardless.

**Fix — 3 levels:**
- **Minimal (default):** `End every reply with a \`\`\`rpg\`\`\` block. Delta-only JSON — only changed fields. Always include vitals + location.` (~25 tokens)
- **Standard (turn 1, or after parse miss):** Add the compact field reference table. (~150 tokens)
- **Full (first response of chat, or 3+ consecutive parse misses):** Full RULE 1–6 schema. (~400 tokens)

Logic: `_parseMisses === 0 && _turnCount > 1` → minimal. `_parseMisses >= 1` → standard. `!initialized || _parseMisses >= 3` → full.

Saving: ~300–350 tokens/turn once stable.

---

### A.4 — System prompt as tiered lorebook (not constant)

**Problem:** The 12KB `system-prompt.md` is used as a constant lorebook entry (~2 800 tokens always on).

**Fix:** Split into keyword-gated lorebook entries:
- `RPG-RULES-CORE` (constant, ~350 tokens): Just RULE 1 format + RULE 4 forbidden table + RULE 5 output order. No field reference.
- `RPG-RULES-COMBAT` (keyword: `combat`, `fight`, `attack`, `HP`): Combat field reference + AP rules.
- `RPG-RULES-QUEST` (keyword: `quest`, `objective`, `mission`): Quest field reference.
- `RPG-RULES-RELATIONSHIPS` (keyword: NPC names, `trust`, `affection`): Relationship delta limits + charInner rules.
- `RPG-RULES-VIR` (keyword: `vir`, `outfit`, `appearance`): VIR field reference + drift rules.
- `RPG-RULES-WORLDBUILDING` (keyword: `faction`, `secret`, `threat`): Factions/secrets/open threats.

Extension provides an "Export to lorebook" button that generates these entries into a new ST lorebook automatically.

Saving: ~2 000–2 500 tokens/turn on typical dialogue turns.

---

### A.5 — Off-scene NPC as keyword-gated lorebook entries

Directly porting VIR's OFFSCREEN tier. When an NPC is removed from `map.peopleHere`:
- Extension writes a lorebook entry: `VIR: <NpcName>` with their last known state (disposition, outfit, trust score, note, goal).
- Keyword: their name.
- Zero tokens until the player or AI mentions them by name.
- When they rejoin the scene (`people_here: true` in rpg block): entry is promoted to TIER 2 inline injection again and lorebook entry is suppressed.

Auto-cleanup: lorebook entries for dead/departed NPCs are flagged with `status: 'departed'` and their keyword entry updated to reflect that.

---

### A.6 — Auto-summarise old state (background compression)

**Problem:** `keyMoments`, `_stateChangelog`, notes accumulate indefinitely.

**Fix:**
- After turn 20, key moments older than 10 turns get compressed into a `_summaries` entry automatically (currently manual only).
- Completed quests older than 5 turns: compress to one line `"[DONE] Quest: <title> — <outcome>"`.
- Resolved secrets, removed threats, dead NPCs: move to a compressed `_archive` object (never injected, kept for GM review in the HUD log tab).
- `_stateChangelog` already rotates at 200; add a UI to view it in the Log tab.

---

## 4. TIER B — Quality & Consistency

### B.1 — VIR handling: self-contained OR bridged to ff4-vir-lorebook-sync

The RPG HUD has its own `vir` field in the rpg block. The `ff4-vir-lorebook-sync` extension is a separate, optional extension that does deeper VIR tracking via lorebook entries and schema 3 JSON fences. Users may have one, both, or neither.

**New setting in HUD panel:** `VIR Mode` — three options:
- **Self-contained (default):** RPG HUD manages its own `[ACTIVE VIR REGISTRY]` block, injected as part of TIER 2 state. No dependency on any other extension. This is the current behaviour, just tiered (only injected when VIR has entries).
- **Bridge (ff4-vir installed):** RPG HUD detects ff4-vir-lorebook-sync by checking `window.FF4_VIR_API` or a known extension settings key. When detected and this mode is selected: HUD forwards vir field updates from the rpg block into the VIR extension's lorebook writer. `[ACTIVE VIR REGISTRY]` injection is removed from HUD state — the VIR extension already injects character entries at the right depth. HUD keeps vir data for GM display only.
- **Off:** HUD does not track or inject VIR at all. Use this if you want the VIR extension to be the sole source of truth and don't want the rpg block `vir` field at all.

**Detection logic (for Bridge mode):**
```js
function virExtensionActive() {
    return typeof window.FF4_VIR_API !== 'undefined'
        || (extension_settings['ff4-vir-lorebook-sync']?.enabled === true);
}
```
If Bridge is selected but the extension is absent, the HUD falls back to Self-contained silently and shows a warning in the panel.

**Self-contained VIR tiering (when not bridged):**
- Active NPCs in scene with VIR entries → injected inline in TIER 2 (~100–150 tokens)
- Off-scene characters with VIR entries → keyword-gated lorebook entry (same A.5 pattern), zero tokens until named
- First appearance of a character → TIER 4 one-shot with their full VIR card

Saving (bridge mode): ~200–600 tokens/turn (VIR block removed from state injection).
Saving (self-contained tiered): ~100–400 tokens/turn (off-scene VIR entries become keyword-only).

---

### B.2 — STATS UPDATE bridge: with or without ff4-vir stats tracker

The ff4-vir extension (when installed) injects a `[WORLD SIMULATION]` + `[STATS TRACKER]` contract that drives visible `─── STATS UPDATE ───` blocks in AI replies. The RPG HUD tracks overlapping data: `charInner`, `vitals`, `npcs[n].trust`, `charDev`, etc.

**This integration is also fully optional.** Two paths:

**Path A — ff4-vir stats tracker NOT present (default):**
RPG HUD is the sole stats system. The rpg block `charInner`, `vitals`, `npcs` fields are the source of truth. The HUD injects them and displays them. No change to current behaviour except the tiered injection optimisation from A.2.

**Path B — ff4-vir stats tracker IS present (opt-in setting: "Sync STATS UPDATE"):**
After each generation, the extension scans the AI reply for the `─── STATS UPDATE ───` markdown block using a simple regex. For each bullet found (`• StatName old → new — reason`), it:
- Maps the stat name against known RPG HUD fields: `Health` → `vitals.hp.value`, `Trust(Name)` → `npcs[Name].trust`, `Arousal` → `charInner.arousal`, etc.
- Applies the delta to the persisted HUD state (same as if the rpg block had updated it)
- Logs the change in `_stateChangelog` with the reason text
- Displays it in the new "Sim" HUD tab (see C.1)

**When both systems run at once:** The rpg block delta and the STATS UPDATE block may both update the same stat. The rule: **rpg block wins** (it is the authoritative machine-readable source). The STATS UPDATE is a human-readable cross-check. If they contradict (rpg says Health -1, STATS UPDATE says Health -2), the contradiction is flagged in the Log tab for GM review.

The mapping table (stat name string → HUD state path) lives in a small config object in index.js, editable per-chat via C.6 (per-chat overlay).

---

---

### B.3 — Heartbeat / drift detection

Every N turns (configurable, default 10) or when `_parseMisses` rises, the extension:
1. Requests a full echo rpg block (`FULL_ECHO_REQUESTED: true` in state injection)
2. On receipt, diffs the full echo against the persisted state
3. Any field the AI echoed differently than stored is flagged as a `_contradiction`
4. Contradictions are shown in the HUD Log tab with the delta highlighted
5. GM Edit Mode allows one-click "accept AI version" or "revert to stored"

---

### B.4 — Smarter active_goal tracking

`active_goal` currently requires the AI to update it manually. Add:
- A "Scene Anchor" that the extension injects with the active goal as the VERY FIRST line of TIER 1 (before vitals), so it acts as a recency anchor at depth 4.
- A goal history log (`_goalHistory`) that records each goal change with turn number for the Log tab.
- "Goal completed" detection: if the AI writes the same active_goal for 5+ turns, prompt it to update.

---

### B.5 — Persona auto-injection scoped to scene

Currently personas are injected for all NPCs whose names are in `peopleHere`. But personas can be large. Add:
- A `persona_compact` field per persona: one-sentence version (`voice` + top `forbidden` only, ~20 tokens)
- Full persona only shown on: (a) NPC's first appearance in a chat session, (b) explicit `/rpg-persona <Name>` slash command, (c) turns where `_parseMisses > 0`
- Saves ~80–120 tokens/NPC/turn in scenes with multiple known NPCs

---

## 5. TIER C — UX & Features

### C.1 — World Simulation tab in HUD

New "World" tab (alongside Overview/Skills/Inventory etc.):
- Shows the `[WORLD SIMULATION]` off-screen character updates from each turn
- Lists each off-screen NPC with their last known state change: "Thorn | Turn 12 | HEALTH -1 (poison not treated) | condition: pale, shaking"
- Updated from the STATS UPDATE block if the bridge (B.2) is active, or from the rpg `npcs` array
- Lets the user click an off-screen NPC to see their full last-known state

### C.2 — Minimap improvements

- Color-code NPC dots by `disposition` (green=friendly, yellow=neutral, red=hostile, grey=offscreen)
- Show NPC names on hover (already partially done via CSS tooltips)
- "Travel log" breadcrumb trail on the map showing last N locations visited
- Click a past location to view the scene_objects and NPCs that were there (from state history)

### C.3 — Slash command interface

Add ST slash commands:
- `/rpg-status` — print current state summary in chat
- `/rpg-npc <Name>` — show full NPC card for that character
- `/rpg-goal <text>` — set the active_goal directly
- `/rpg-fact add <text>` — add a pinned fact without waiting for AI
- `/rpg-fact remove <id>` — remove a fact
- `/rpg-echo` — force a full echo request on the next generation
- `/rpg-export` — export system prompt sections as a new lorebook (see A.4)

### C.4 — Log tab improvements

Currently "notes" are stored but the Log tab is basic. Improve:
- Timeline view: entries grouped by location, not just by turn number
- Filter by type: quest update / NPC event / stat change / key moment / world sim
- Search bar to find when a fact or NPC note changed
- "Story So Far" auto-summary button: sends the last N turns of notes to the AI and asks it to generate a compressed paragraph summary → stored in `_summaries`

### C.5 — GM Mode improvements

- Bulk edit: open a JSON editor for the entire state (for power users)
- "Rewind" button: revert state to N turns ago using `_stateChangelog`
- NPC quick-add form: fill in name/role/disposition/trust in a form instead of waiting for the AI to create it
- Quest board view: drag-and-drop quest steps to reorder, mark steps complete manually

### C.6 — Per-chat system prompt customisation

Instead of one global `system-prompt.md`, let each chat have its own rule overlay:
- In the HUD settings panel: a small textarea for "Chat-specific rule additions"
- Injected as a tiny lorebook entry keyed to that chat only
- Use case: one chat is a horror game (needs horror accuracy rule always on), another is pure romance (relationship rules priority). Currently these need a full system prompt swap.

---

## 6. Implementation Order

```
Phase 1 (token savings, standalone):
  A.3 — Adaptive FORMAT_REMINDER     (index.js, 1 function change)
  A.1 — Delta-only rpg blocks        (system-prompt.md rewrite + buildPromptText tweak)
  A.2 — Tiered state injection        (refactor buildPromptText into tier functions)
  A.5 — Off-scene NPC lorebook       (new function, write NPC entries on peopleHere change)

Phase 2 (quality, after Phase 1 stable):
  B.3 — Heartbeat / drift detection   (new delta-diff logic + Log tab entries)
  B.5 — Persona compact mode          (add persona_compact field, inject logic)
  B.4 — active_goal as scene anchor   (move to top of TIER 1 injection)
  A.6 — Auto-summarise old state      (background job on turn increment)

Phase 3 (integration):
  A.4 — System prompt as lorebook     (new exportToLorebook() function + UI button)
  B.1 — VIR bridge                    (link to ff4-vir-lorebook-sync writer)
  B.2 — STATS UPDATE bridge           (parse STATS UPDATE markdown from replies)

Phase 4 (UX):
  C.1 — World Simulation tab
  C.3 — Slash commands
  C.4 — Log tab improvements
  C.5 — GM Mode improvements
  C.2 — Minimap improvements
  C.6 — Per-chat rule overlay
```

---

## 7. Expected Token Savings (mid-game scenario, 5 NPCs, 3 quests)

| Change | Saving per turn | Requires VIR ext? |
|---|---|---|
| A.1 Delta-only rpg blocks | −500 to −800 | No |
| A.2 Tiered state injection | −150 to −300 | No |
| A.3 Adaptive FORMAT_REMINDER | −300 to −350 | No |
| A.4 System prompt lorebook split | −2 000 to −2 500 | No |
| A.5 Off-scene NPC keyword gating | −100 to −300 | No |
| B.1 VIR bridge (bridge mode, VIR ext present) | −200 to −600 | Yes — optional |
| B.1 VIR self-contained tiered (no VIR ext) | −100 to −400 | No |
| B.5 Persona compact mode | −80 to −240 | No |
| **Total — no VIR extension** | **−3 000 to −4 200 tokens/turn** | |
| **Total — with VIR extension bridged** | **−3 300 to −4 700 tokens/turn** | |

Current mid-game cost: ~4 000–5 000 tokens overhead.
After Phase 1+2 (no VIR ext): ~500–1 000 tokens overhead.
After Phase 1+2 (with VIR ext bridged): ~300–700 tokens overhead.

The VIR extension is purely additive — everything in Phase 1 and 2 works identically with or without it. Phase 3 B.1/B.2 unlock extra savings when it is present.

---

## 8. Non-goals (out of scope for v4)

- New stat types or rpg mechanics — keep schema stable
- Changing the rpg block format from JSON (too many AI presets rely on it)
- A companion mobile app
- Server-side storage (ST is local-first)
